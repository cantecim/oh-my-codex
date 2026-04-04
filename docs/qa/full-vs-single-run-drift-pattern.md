# Full Suite vs Tekli Run Drift Pattern

Bu doküman, özellikle `OMX_TEST_DEBUG=1` altında görünen full-suite/tekli-run drift problemlerini kapatırken hangi pattern’in işe yaradığını net biçimde kaydeder.

Amaç:
- aynı fail’in full suite’te çıkıp tekli koşuda kaybolduğu durumları sistematik çözmek
- runtime bug ile test/debug launch bug’ını ayırmak
- transport testlerini yanlış katmanda “yumuşatmadan” stabilize etmek

## Core Rule

Önce drift’i kapat, sonra runtime root cause’a git.

Eğer bir fail:
- full suite’te çıkıyor
- tekli veya küçük hedefli run’da kayboluyorsa

ilk varsayım runtime bug değil, **test/debug launch surface drift** olmalı.

İkinci kural:
- runtime code path test-debug contract detaylarını bilmemeli
- runtime yalnız internal trace adapter’a yazmalı
- fixture/artifact ownership test-support ve debug artifact layer’da kalmalı

Bu ayrım, debug altyapısının production/runtime behavior’a etkisini sıfıra yaklaştırır.

## Canonical Pattern

### 1. Child process launch contract tek biçim olmalı

Child `spawnSync` / `spawn` çağrıları için kanonik pattern:

```ts
env: buildIsolatedEnv({
  ...buildDebugChildEnv(cwd),
  ...overrides,
})
cwd: fixtureTempDir
```

Kurallar:
- child `cwd` her zaman fixture temp dir
- child env doğrudan `...process.env` spread etmemeli
- launch helper mümkünse test dosyası içinde ortaklaştırılmalı

Bu, repo root’a bağlı shared debug artifact ve env kirlenmesini azaltır.

### 2. Debug artifact ownership fixture bazlı olmalı

`OMX_TEST_ARTIFACTS_DIR` ortak root olabilir, ama artifact namespace test-specific olmalı.

Kural:
- `OMX_TEST_DEBUG_TEST_ID` fixture `cwd` bazlı üretilmeli
- child process’ler repo root test-id’sini paylaşmamalı

Sonuç:
- trace ve process-runner artifact’leri farklı testler arasında üst üste binmez
- full suite altında “başka testin trace’i bana karıştı” sınıfı sorunlar azalır

### 3. Transport testlerinde `tmux.log` ve `send-keys` zorunlu contract’tır

Eğer testin intent’i tmux transport doğrulamaksa:
- `tmux.log` zorunlu
- `send-keys` zorunlu

Yanlış çözüm:
- `tmux.log` yoksa event/state fallback ile testi geçir

Doğru çözüm:
- `tmux.log`’u yaratması gereken katmanı düzelt
- fake tmux contract’ını deterministic yap

Yani:
- `ENOENT` bir assertion-softening gerekçesi değildir
- önce log owner fixlenir

### 4. Fake tmux ortak helper’dan gelmeli

Kanonik surface:
- `buildFakeTmuxScript()`

Beklenen davranış:
- `tmux.log` create-on-first-use
- `tmux.log.meta.jsonl`
- deterministic `display-message`
- deterministic `list-panes`
- deterministic `capture-pane`
- deterministic `send-keys`

Kural:
- local inline fake tmux varyasyonları minimum olmalı
- mümkün olduğunca shared helper opsiyonlarıyla ifade edilmeli

### 5. Drift teşhisinde process trace birinci sınıf sinyal

Drift analizi için öncelik sırası:
1. `process-runner.jsonl`
2. `decision-trace.jsonl`
3. `tmux.log`

Yorum:
- `tmux.log` varsa güçlü transport kanıtıdır
- `tmux.log` yoksa tek başına runtime bug denemez
- önce process trace ve decision trace okunur

Özellikle ayrıştırılacak durumlar:
- `timeout` + no send path
- wrong branch / rejected branch
- transport oldu ama assertion surface yanlış yere bakıyor

### 6. Timeout false negative’leri bounded retry ile kapat

Probe-style tmux çağrılarında timeout hemen “not found / not alive” sayılmamalı.

Doğru pattern:
- timeout’a özel bounded retry
- gerçek empty / gerçek nonzero behavior broadlaştırılmadan korunur

Bu özellikle:
- `list-panes`
- liveness probes
- leader/worker pane keşfi
gibi yüzeylerde geçerlidir.

### 7. Full suite fail’i mini-sequence repro’ya indir

Amaç:
- fail’i full suite dışında da üretilebilir hale getirmek

Yöntem:
- failing test
- komşu aynı-surface testler
- aynı launcher/fake-tmux contract kullanan predecessor testler

çıkarılır ve küçük bir sequence halinde koşturulur.

Bu sequence:
- repo içinde script/harness olarak saklanmalı
- sonraki debug turlarında yeniden kullanılmalı

Runtime root cause çalışması ancak bundan sonra ucuzlar.

Mevcut örnek harness:
- [src/scripts/repro-tmux-heal-drift-harness.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/scripts/repro-tmux-heal-drift-harness.ts)

Amaç:
- `notify-hook-tmux-heal` drift’ini full suite dışında küçük bir sequence ile tekrar koşturmak
- launch/env/cwd contract değişikliklerinden sonra hızlı regresyon kontrolü yapmak

## Effective Failure Branch Reading

`first_wrong_branch` tek başına yeterli olmayabilir.

Özellikle watcher lane’lerinde:
- erken “garip ama masum” event
- gerçek failure branch’ini gölgeleyebilir

Bu yüzden summary okurken:
- final-relevant decision
- timeout process event’i
- no-send result
öncelikli okunmalı

Pratik kural:
- `send_keys_seen=false` ve process trace’de `timeout` varsa, effective failure branch timeout kabul edilir
- yoksa decision trace’in sondan başa failure-like branch’i kullanılır

## What Not To Do

- `tmux.log` yok diye behavior-only fallback ile transport testini geçirmek
- child env’i `...process.env` ile körlemesine yaymak
- child process’i repo root `cwd` ile çalıştırmak
- drift ayrıştırılmadan runtime code path’e test-debug branching taşımak
- drift varken doğrudan runtime logic’e büyük patch atmak
- full suite’te çıkan faili önce mini-sequence’e indirmeden “root cause bulundu” demek

## Practical Checklist

Bir drift fail’iyle karşılaşınca:

1. Test transport mu behavior mı, bunu belirle
2. Child launch helper var mı, yoksa ortaklaştır
3. Child `cwd` fixture temp dir mi, kontrol et
4. `buildDebugChildEnv(cwd)` gerçekten child’a gidiyor mu, kontrol et
5. `tmux.log` owner deterministic mi, kontrol et
6. `process-runner.jsonl` ve `decision-trace.jsonl` oku
7. Fail’i mini-sequence’e indir
8. Hâlâ kalıyorsa runtime root cause’a geç

## Proven Gains

Bu pattern aşağıdaki tür sorunları daraltmakta işe yaradı:
- `notify-hook-tmux-heal` full-suite drift
- `notify-fallback-watcher` stale leader nudge drift
- `leader-nudge` trace/artifact ownership karışmaları

Ana kazanım:
- runtime bug ile test/debug launch bug’ını erken ayırmak
- yanlış katmanda test softening yapmamak
- aynı çözüm yüzeyini başka flaky lane’lere uygulanabilir hale getirmek
