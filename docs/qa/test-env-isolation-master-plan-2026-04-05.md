# Hermetic Test Execution Master Plan

Bu doküman, notify/tmux drift çözümleme sonrası kalan asıl problemi tanımlar.

Bu problem yalnız env izolasyonu değildir; test execution'ın tamamının hermetic olmamasıdır.

Ana contamination yüzeyleri:

1. `process.env` mutation
2. in-process test execution
3. shared helper'ın ambient env okuması
4. `process.chdir()`
5. process-global runtime selectors

Bu yüzeylerin ortak sonucu:

- bir test başka bir testten state miras alabiliyor
- full suite ve tekli run farklı davranabiliyor
- runtime code path değil, test execution topology flaky hale geliyor

Amaç:

- her test case'i hermetic hale getirmek
- drift'i “tekrar arızalanınca kovalanan” bir semptom olmaktan çıkarıp yapısal olarak engellemek
- env propagation'ı tek contract altında toplamak
- env dışındaki process-global state yüzeylerini de aynı isolation modeliyle ele almak
- senior engineer seviyesinde uygulanabilir, review edilebilir, durakları net bir rollout planı üretmek

Bu plan, [Full Suite vs Tekli Run Drift Pattern](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/docs/qa/full-vs-single-run-drift-pattern.md) belgesini tamamlar.

## Executive Summary

Temel karar:

- her test case isolated env ile başlar
- hiçbir child process doğrudan `process.env` almaz
- env propagation zinciri daima şu şekildedir:

```text
process.env
  -> isolated env
    -> explicit child env
      -> explicit nested child env
```

Ek kararlar:

- `OMX_TEST_*` env yüzeyi bilinçli test taşıma contract'ıdır
- `OMX_TEST_*` auto-forward whitelist'tir
- bunun dışındaki env'ler explicit olarak taşınmadıkça aktarılmaz
- `process.chdir()`, import-time singleton state, process-global runtime selectors ve shared helper ambient reads de contamination surface kabul edilir
- yani hedef yalnız “clean env” değil, **hermetic test execution**'dır

Bu plan için rollout modeli:

- **guided explicit-first**

Yani:

- önce canonical isolated env contract kurulur
- sonra mevcut testlerde bilinen gerekli env'ler explicit taşınır
- fail eden yerlerde eksik bağımlılıklar görünür hale geldikçe explicit listeler tamamlanır

Bu, repo ölçeğinde strict-first'ten daha uygulanabilir; ama notify/tmux gibi drift-prone ailelerde yine de “minimum inherited env” çizgisi korunur.

## Non-Negotiable Rules

### 1. Every case starts isolated

Her test case şu varsayımla başlamalıdır:

- inherited process env güvenilir değildir
- başka bir testin env mutation'ı benim case'ime ulaşmamalıdır
- testin çalışması için gereken env açıkça test tarafından tanımlanmalıdır

Bu yüzden:

- `env: process.env` yasak
- `env: { ...process.env, ...overrides }` yasak
- child test lane'lerinde kör `PATH` inheritance yasak

### 2. `OMX_TEST_*` is the only auto-forward whitelist

`OMX_TEST_*` env ailesi özel durumdur.

Sebep:

- bunlar runtime branching için değil
- test/debug artifact ve harness transport'ı için tasarlanmış kontrollü surface'tir

Canonical policy:

- `OMX_TEST_*` auto-forward edilir
- bu auto-forward tek yerden yapılır
- helper'lar `OMX_TEST_*` okusa bile bunu explicit test contract'ın parçası olarak yapar

Bu kuralın dışındaki env'ler:

- explicit olarak belirtilmedikçe taşınmaz

### 3. Runtime-affecting env must always be explicit

Aşağıdaki env sınıfı runtime-affecting kabul edilir:

- `PATH`
- `OMX_RUNTIME_BINARY`
- `TMUX`
- `TMUX_PANE`
- `OMX_TEAM_WORKER`
- `OMX_TEAM_STATE_ROOT`
- `OMX_TEAM_LEADER_CWD`
- `OMX_MODEL_INSTRUCTIONS_FILE`
- `CODEX_HOME`
- benzeri code path, transport, binary selection veya authority selection etkileyen env'ler

Kural:

- bu env'ler ancak explicit override ile child'a gider
- default'ta empty/reset edilir veya canonical safe value alır

### 4. In-process tests do not get to freeload on ambient env

Bir test aynı process içinde modül import edip fonksiyon çağırıyorsa:

- ya `withEnv` benzeri scoped helper ile tam restore garantisi altında çalışmalı
- ya da child process'e taşınmalı

Tercih sırası:

1. child process + isolated env
2. geçici olarak `withEnv` + strict restore

### 5. Shared helpers must be pure with respect to ambient runtime env

Helper purity kuralı:

- helper behavior'ı ambient `process.env` tarafından “tesadüfen” değişmemeli
- helper ihtiyacı olan state'i explicit option veya explicit env contract üzerinden almalı

Özellikle fake tmux helper için:

- test helper'ın behavior'ı ambient runtime env mutation yüzünden değişmemeli
- bir testin capture/sequence/runtime selection ayarı başka bir testin helper davranışını değiştirmemeli

## Canonical Contract

## Base API

Canonical isolated env API ailesi:

```ts
buildIsolatedEnv(overrides);
buildDebugChildEnv(cwd);
buildChildEnv(cwd, overrides); // thin wrapper
```

Beklenen davranış:

- `buildIsolatedEnv()`:
  - sterile base env üretir
  - `OMX_TEST_*` auto-forward eder
  - runtime-affecting env'leri empty/reset default ile başlatır
- `buildDebugChildEnv(cwd)`:
  - yalnız debug/test artifact metadata üretir
- `buildChildEnv(cwd, overrides)`:
  - canonical composition noktasıdır

Önerilen pattern:

```ts
env: buildIsolatedEnv({
  ...buildDebugChildEnv(cwd),
  ...overrides,
});
```

### Child process rule

Child process launch için kanonik pattern:

```ts
spawnSync(cmd, argv, {
  cwd,
  env: buildIsolatedEnv({
    ...buildDebugChildEnv(cwd),
    PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    TMUX: "",
    TMUX_PANE: "",
    ...explicitOverrides,
  }),
});
```

### In-process fallback rule

Eğer child process'e taşımak hemen mümkün değilse:

- scoped helper ile env set edilir
- helper test sonunda restore eder
- test explicit env snapshot alır
- restore başarısızlığı fail sayılır

Bu pattern geçici kabul edilir; nihai hedef child-process isolation'dır.

## Allowed vs Forbidden Patterns

### Allowed

- `buildIsolatedEnv({ ...buildDebugChildEnv(cwd), ...overrides })`
- `withEnv({ KEY: value }, async () => { ... })` yalnız migration veya gerçek in-process zorunlulukta
- `OMX_TEST_*` auto-forward
- fixture-local `cwd`
- fixture-local temp artifact path

### Forbidden

- `env: process.env`
- `env: { ...process.env, ... }`
- test ortasında `process.env.PATH = ...` ve aynı process içinde runtime call
- test ortasında `process.env.OMX_RUNTIME_BINARY = ...` ve restore discipline olmadan import/call
- ambient `TMUX` / `TMUX_PANE` bağımlılığı
- helper'ın implicit ambient env ile behavior değiştirmesi

## Shared State Surfaces To Track

Env dışında izlenecek diğer global/shared state yüzeyleri:

### 1. `process.chdir()`

Bu da drift kaynağıdır.

Kural:

- mümkünse kullanılmamalı
- gerekiyorsa scoped restore zorunlu

### 2. In-process execution and module cache / singleton state

Örnek risk:

- import-time env snapshot
- static config resolution
- runtime binary selection cache
- same-process test ordering

Kural:

- import-time branch selection yapan modüller child process'te test edilmeye daha uygundur
- in-process test execution, hermetic child-process modele göre ikinci sınıf kabul edilir

### 3. Shared helper ambient reads and shared temp artifacts

Örnek:

- `tmux.log`
- capture sequence files
- counter files
- runtime log files
- helper'ın ambient `process.env` ile branch değiştirmesi

Kural:

- ownership fixture-local olmalı
- “çağrılırsa oluşur” varsayımı yerine explicit owner tanımlanmalı
- helper behavior'ı fixture-local option/env contract dışında değişmemeli

### 4. Timers / background loops

Özellikle watcher ve runtime lane'lerinde:

- pending timers
- detached child processes
- long-lived loops

Kural:

- test sonunda kapatılmayan background state test contamination sayılır

## Rollout Strategy

Bu iş için önerilen toplam rollout:

- **4 pass**

Sebep:

- 2 pass çok büyük ve riskli
- 5+ pass gereksiz uzatır
- 4 pass, hem notify/tmux önceliğini hem repo-geneli enforcement'ı taşıyacak kadar dengeli

## Pass 1: Isolation Contract Hardening

Amaç:

- tek canonical isolation contract'ı netleştirmek
- helper düzeyinde inheritance kurallarını stabilize etmek
- hermetic execution sınırlarını netleştirmek

Çalışma:

- `buildIsolatedEnv` / `buildDebugChildEnv` / thin child wrapper final shape
- `OMX_TEST_*` auto-forward policy netleştirme
- runtime-affecting env reset matrix çıkarma
- shared helper purity audit
- `process.chdir()` / in-process fallback / module-cache risk kurallarını netleştirme

Acceptance:

- tek source-of-truth isolation contract var
- dokümantasyon + helper behavior uyumlu
- yeni testler için canonical pattern hazır

## Pass 2: Notify/Tmux Isolation Migration

Amaç:

- drift-prone notify/tmux test ailesini tamamen hermetic hale getirmek

Kapsam:

- notify hook testleri
- fallback watcher
- team dispatch / leader nudge / tmux heal / tmux guard
- fake tmux helper kullanan tüm critical lane'ler

Kurallar:

- child env -> isolated env
- in-process `process.env` mutation -> child process veya scoped explicit env
- fake tmux helper ambient runtime env'den ayrılır
- `process.chdir()` ve process-global runtime selector leakage kapatılır

Acceptance:

- notify/tmux ailesinde `env: process.env` ve `...process.env` yok
- `PATH`, `OMX_RUNTIME_BINARY`, `TMUX*` explicit
- same-process freeloading kalmıyor veya documented temporary fallback'a iniyor
- debug kapalı targeted suite green

## Pass 3: Global Mutation Families

Amaç:

- notify/tmux dışındaki en riskli process-global contamination ailelerini kapatmak

Öncelik:

- `team/*`
- `mcp/*`
- `cli/*`
- runtime-bridge ve tmux session testleri

Özellikle hedeflenecek mutation pattern'leri:

- `process.env.PATH =`
- `process.env.OMX_RUNTIME_BINARY =`
- `delete process.env.TMUX`
- `process.env.TMUX_PANE =`
- `process.chdir(...)`
- import-time runtime selector caching
- same-process runtime branch selection

Acceptance:

- scoped restore'suz process-global mutation kalmaması
- child-process'e taşınabilecekler taşınmış olması
- repo genel drift riski düşmüş olması

## Pass 4: Enforcement + Residual Sweep

Amaç:

- kalan istisnaları kapatmak
- kuralları kalıcı hale getirmek

Çalışma:

- targeted residual migration
- static search checks
- docs finalization
- gerekiyorsa lint/test grep gate

Acceptance:

- canonical rule set repo standardı haline gelmiş
- residual exceptions documented
- full suite normal acceptance ile güvenilir

## Guided Explicit-First Implementation Policy

Bu rollout'ta uygulanacak migration politikası:

### Default

- önce mevcut testin gerçekten ihtiyaç duyduğu env'ler explicit listelenir
- minimum env ile çalıştırılır
- fail ederse eksik dependency eklenir

### Why not strict-first everywhere?

Çünkü:

- repo genelinde çok fazla global env mutation var
- bir anda sıfır-env denemesi operasyonel olarak pahalı olur
- guided explicit-first, migration hızını artırırken dependency'leri yine görünür kılar

### Where strict behavior still applies

Notify/tmux gibi drift-prone ailelerde:

- inheritance minimum tutulur
- new test code için zero-runtime-inheritance mindset korunur
- `OMX_TEST_*` dışındaki hiçbir env “belki lazımdır” diye geçmez

## Acceptance Gates

Her pass sonunda:

1. `npm run build`
2. `npm run check:no-unused`
3. ilgili targeted suites
4. kullanıcı ortamında normal full suite

Program final acceptance'ta ayrıca:

1. none

Drift özel notu:

- debug-open parity artık primary gate değildir
- normal debug-off full suite primary acceptance'tır
- debug-open yalnız teşhis amaçlı kalır

## Static Search Recipe

Pass 2 ve sonrası review/checklist için kullanılacak minimum taramalar:

```bash
rg -n "env:\\s*process\\.env|\\.\\.\\.process\\.env" src
rg -n "process\\.env\\.(PATH|OMX_RUNTIME_BINARY|TMUX|TMUX_PANE)\\s*=|delete process\\.env\\.(PATH|OMX_RUNTIME_BINARY|TMUX|TMUX_PANE)" src
rg -n "process\\.chdir\\(" src
rg -n "spawn(Sync)?\\(" src/hooks src/team src/mcp src/cli
```

Yorumlama:

- hit görmek tek başına hata değildir
- ama her hit şu soruyu cevaplamak zorundadır:
  - bu env/state neden same-process mutation ile çözülüyor?
  - child-process + isolated env ile çözülemiyor mu?
  - restore/disposal explicit ve test-covered mı?

Geçici istisna modeli:

- same-process mutation yalnız documented temporary fallback ise kabul edilir
- restore path'i aynı test içinde görünür olmalıdır
- Pass 3 sonuna kadar child-process modele taşınamayan istisnalar dosya içinde kısa notla gerekçelendirilmelidir

## Review Checklist

Bir PR bu plana uyumlu mu diye bakarken:

1. Yeni child process `buildIsolatedEnv(...)` kullanıyor mu?
2. `OMX_TEST_*` dışındaki env explicit mi?
3. `env: process.env` veya `...process.env` var mı?
4. test in-process çalışıyorsa env restore tam mı?
5. helper ambient env okuyor mu?
6. fake tmux/helper behavior fixture-local ownership ile mi tanımlanmış?
7. `process.chdir()` veya process-global state restore ediliyor mu?

## Immediate Hotspots

Bu plan başlarken öncelikli sıcak noktalar:

- [src/hooks/**tests**/notify-hook-team-dispatch.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/hooks/__tests__/notify-hook-team-dispatch.test.ts)
- [src/hooks/**tests**/notify-hook-team-tmux-guard.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/hooks/__tests__/notify-hook-team-tmux-guard.test.ts)
- [src/test-support/shared-harness.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/test-support/shared-harness.ts)
- [src/team/**tests**/runtime.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/__tests__/runtime.test.ts)
- [src/team/**tests**/tmux-session.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/__tests__/tmux-session.test.ts)
- [src/mcp/**tests**/state-server.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/mcp/__tests__/state-server.test.ts)

Sebep:

- process-global env mutation yoğunluğu yüksek
- PATH/TMUX/runtime-binary selection burada yapılıyor
- drift ve suite-order contamination burada tekrar üretilebilir

## Final Position

Bu planın hedefi yalnız flaky test azaltmak değildir.

Asıl hedef:

- test execution semantics'ini netleştirmek
- env propagation'ı bir contract altına almak
- env dışındaki process-global state yüzeylerini de aynı contract içine almak
- drift'i debug tooling ile teşhis edilen bir semptom olmaktan çıkarıp mimari olarak önlemek

Bu iş tamamlandığında beklenen durum:

- her case hermetic başlar
- `OMX_TEST_*` harici env inheritance explicit olur
- in-process freeloading minimuma iner
- helper purity netleşir
- `process.chdir()` ve runtime selector leakage bounded hale gelir
- child process chain deterministic hale gelir
- full suite ile tekli run arasındaki env-drift sınıfı sorunlar yapısal olarak azalır
