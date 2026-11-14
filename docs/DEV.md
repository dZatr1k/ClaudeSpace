# ClaudeSpace — разработка

Состояние: этапы 0–4, 6, 7 (кроме проверок на Windows), 2026-11-14.

## Быстрый старт

```bash
cd ~/projects/ClaudeSpace
npm install                 # Node 22+
npm run dev:vm              # на этой VM (Electron с --no-sandbox, см. ниже); на Windows — npm run dev
```

- На VM нужен графический сеанс (RDP/XFCE): `DISPLAY` должен указывать на X-сервер.
- По умолчанию в Linux режим подключения **«Локально»**: агент и tmux запускаются на этой же машине, SSH не нужен.
  В Windows по умолчанию **SSH** (Host `vm` из `%USERPROFILE%\.ssh\config`, ключ через ssh-agent или пароль ключа).
  Переключение: Настройки → Подключение.
- `npm run build` — typecheck + сборка в `out/`; `npm run start:vm` — запуск собранного.
- `npm run agent:manifest` — собрать бандл агента в `resources/agent/` (делается автоматически в dev/build);
  `npm run agent:install` — поставить агент в `~/.local/lib/claudespace/` напрямую.

Почему `--no-sandbox` на VM: Electron требует setuid-root `chrome-sandbox` или user namespaces; на Ubuntu 24.04
непривилегированные userns запрещены AppArmor, а sudo мы не используем. В коде окна `sandbox: true` остаётся.

## Тесты

| Команда | Что | Сколько |
|---|---|---|
| `npm run test:agent` | агент: unittest (stdlib), фейковый HOME, реальный tmux на отдельном сокете `claudespace-test-py-*` | 90 |
| `npm run test:unit` | vitest: unit (hostkey, rpc, keymap, format, stores, terminals, settings, ports, askpass, search, tray…) + integration | 110 |
| `npm test` | оба набора | 200 |
| `npm run test:e2e` | Playwright `_electron`: окно, сайдбар, терминал, палитра, оверлеи, пароль sudo, поиск по чатам, закрытие в трей, обрыв, перезапуск; скриншоты в `docs/screenshots/`, включая узкое окно 960×600 и светлую тему (собирает `out/`: сначала `npm run build`) | 1 сценарий |
| `npm run lint`, `npm run typecheck` | ESLint + Prettier, `tsc` strict для main/preload/shared и renderer | |

- **Интеграционные тесты** (`tests/integration/`):
  - `ssh.test.ts` — настоящий SSH: in-process `ssh2` Server на 127.0.0.1 с сгенерированными ключами (в `~/.ssh`
    ничего не пишется): TOFU нового ключа хоста, отказ при изменённом ключе, отвергнутый ключ, ключ с паролем
    (неверный/верный), установка агента по SFTP и переустановка при изменении, RPC, терминал tmux через SSH PTY
    (ресайз, `Ctrl+B d`), flow control (`yes | head -c 30M` без подтверждений → пауза), обрыв сети и `debugDrop`
    с автоматическим переподключением.
  - `local.test.ts` — локальный транспорт: установщик, агент, вкладка tmux с кириллицей и рамками.
- Тесты, создающие tmux-сессии, используют свой сокет (`tmux -L claudespace-test-*`) и убивают его в конце.
  Пользовательские сессии не трогаются.
- e2e нужен X-дисплей: `DISPLAY=:10 npm run test:e2e` (на VM — сеанс xrdp; `xvfb-run` не установлен). Окно
  на ~30 с появляется на рабочем столе. Используется фейковый HOME, данные пользователя в скриншоты не попадают.

## Архитектура (как построено)

```
renderer (React, sandbox) ──window.cs (preload, whitelist)──► main (Node)
                                                              ├ ipc.ts       zod-проверка каждого канала
                                                              ├ connection.ts  config → auth → hostkey → agent,
                                                              │                backoff 1/2/4/8/16/30 с ±20 %, ping/RTT
                                                              ├ transport/   ssh.ts (ssh2) | local.ts (+ptyhelper.py)
                                                              ├ agent/       installer.ts (MANIFEST, SFTP, sha256, mv)
                                                              │              rpc.ts (JSON Lines, таймауты, события)
                                                              ├ terminals.ts PTY-каналы, пачки 8 мс, пауза > 1 МБ
                                                              ├ store.ts     settings.json / workspace.json / snapshot
                                                              └ launch.ts    RDP (powershell -File), VS Code
VM: python3 -I ~/.local/lib/claudespace/csagent.py serve --protocol 1  (agent/csagent.py + agent/cclib/*)
```

- **Агент** (`agent/`): `csagent.py` — цикл `selectors` + опрос (реестр 1 с, tmux 2 с, транскрипты 3 с,
  проекты/git 30 с или при изменении, system 10 с), долгие методы в пуле из 2 потоков. `cclib/` — перенос логики
  `ccdata.py` без форматирования (`paths`, `chats`, `sessions`, `tmux`, `projects`, `usage`, `doctor`, `system`).
  Кэш индекса — `~/.cache/claudespace/chats.json`, псевдонимы — `~/.local/state/claudespace/titles.json`, архив —
  общий с `cc` (`~/.claude/cc-menu-archive/`).
- **Безопасность агента**: аудит-хук запрещает открывать `.credentials*`, `settings.local.json`, `history.jsonl`,
  `sessions/*.key`, `~/.ssh/**` (тест `test_security.py` прогоняет все методы и проверяет журнал открытий); нет метода
  «выполнить команду»; tmux/git — списком аргументов; пути — `realpath` внутри `$HOME`; `chatId` и имена сессий —
  по regex; команда `claude --resume` экранируется `shlex.quote`.
- **Electron**: `contextIsolation`, `sandbox`, без `nodeIntegration`, CSP (`default-src 'self'`), запрет навигации
  и новых окон (ссылки — только http(s) через `shell.openExternal`), `Menu.setApplicationMenu(null)`, DevTools только
  в dev, IPC — только каналы из `src/shared/channels.ts`, аргументы проверяются zod.
- **Renderer**: zustand-сторы `conn`, `data` (обновляются событиями агента), `tabs`, `ui`; `commands.ts` — реестр
  действий для палитры/хоткеев; `keymap.ts` — таблица §6; `components/Terminal/controller.ts` — xterm.js
  (fit, webgl с откатом на DOM, unicode11, web-links, search, clipboard/OSC 52 только запись), подтверждения
  прочитанных байт (`term.ack`).
- **Уведомления в приложении** (BACKLOG 2): `lib/notify.ts` — чистый детектор `busy → waiting/idle` по снимкам
  `active_changed` (debounce, приглушение, сброс при `sessionsSynced = false`) и правило «только фон»;
  `notifier.ts` — подписка на `useData`, toast, звук (`lib/chime.ts`, WebAudio, без файлов) и подсветка
  `.anim-flash`; настройки `settings.notifications`. Звук на Windows не проверен.
- **Файлы userData**: `settings.json`, `workspace.json` (вкладки tmux, активная, размеры панелей, окно),
  `cache/snapshot.json` (последние списки — сайдбар заполнен сразу при запуске), `known_hosts` (TOFU приложения),
  `logs/main.log` (ротация 5×1 МБ). Для тестов путь переопределяется `CLAUDESPACE_USER_DATA`.

## Что не проверено

- **Реальный SSH к VM** (ключ пользователя, ssh-agent Windows `\\.\pipe\openssh-ssh-agent`, `~/.ssh/config` на ПК,
  настоящий known_hosts с `|1|`-хэшами) — нет ключа в `authorized_keys` на VM и запрещено трогать ПК. Путь SSH
  проверен только против тестового ssh2-сервера.
- **Windows**: dev-сборка на ПК, `titleBarOverlay`, тосты, RDP-скрипт, поиск `code.cmd` и запуск VS Code Remote-SSH
  (`cmd.exe /c code.cmd --folder-uri …`), горячие клавиши в Windows — не запускалось.
- **OSC 52 из tmux copy-mode в буфер**: обработчик в приложении есть (addon-clipboard → `clipboard.write`), но на
  этой VM в tmux, скорее всего, нужна строка `set -as terminal-features ',xterm-256color:clipboard'` в `~/.tmux.conf`
  (не трогали). Обходной путь: `Shift+drag` — выделение средствами xterm.js и `Ctrl+C`/`Ctrl+Shift+C`.
- **Claude Code в терминале приложения**: спиннеры/эмодзи настоящего Claude Code и светлая тема не проверялись
  (в e2e — фейковый `claude`; кириллица и рамки проверены). Две копии клиента (cc + приложение) и
  `window-size latest` — не проверены вручную.
- Вставка 1 МБ через UI и рост памяти renderer при `yes` — проверено только на уровне main (пауза канала без
  подтверждений), не профилировалось в окне.
- Ручная полудневная работа с приложением (критерий этапа 3) не проводилась.

### Уведомления «Claude ответил / ждёт ввода» (2026-11-09)
- Источник — хук пользователя `~/.claude/hooks/notify.sh` (Stop/Notification): функция `emit_claudespace` дописывает строку в
  `~/.cache/claudespace/events.jsonl`. 
- Агент: `cclib/turns.py` (`TurnTail`, только новые события, переживает обрезку файла), событие `turn_done` с tmux-сессией.
- Приложение: `src/renderer/notifier.ts` → уведомление Windows (`notify.show` в main, клик открывает сессию), звук-файл с ПК
  (`sound.load`), опционально toast. Решения пишутся в `main.log` строкой `[notify]`.
- Старый детектор по статусам (`detectDone` в `lib/notify.ts`) больше не подключён; оставлен вместе с тестами.

### ПК ↔ VM: обратный туннель и «Диск ПК» (BACKLOG 12, 2026-11-09)
- Main: `src/main/pclink.ts` (`PcLink`, подписан на `Connection`: `online`/`state`/`winfs_changed`). При каждом подключении
  по SSH: агент `pc_tunnel_status` → свободно → `transport.forwardIn('127.0.0.1', 2222)`; входящие соединения →
  `net.connect(127.0.0.1:22)` на ПК. Занято → состояние `foreign`/`busy` и повтор каждые 15 с. Пока туннель наш —
  проверка sshd ПК раз в 15 с. IPC: `pclink.state|mount|unmount|reconnect`, событие `pclink.state`.
- Агент: `cclib/winfs.py` (проверка путей, mountinfo, владение, вызов `~/.local/bin/winfs`, `fusermount3 -u`),
  `cclib/netstat.py` (`/proc/net/tcp{,6}`, inode → pid). Для тестов `CSAGENT_MOUNTINFO` подменяет `/proc/self/mountinfo`.
- Настройки `pcLink`: `tunnel` (вкл. только в Windows), `autoMount`, `mounts` (по умолчанию пусто; пример — `C:\Data → ~/winfs/V`).
- Выход: `window-all-closed` → `pclink.shutdown()` (≤ 5 с: ленивое отключение своих дисков, `unforwardIn`) → отключение.
- Тесты: `agent/tests/test_winfs.py` (фейковые `winfs`/`fusermount3` в фейковом HOME), `tests/integration/pclink.test.ts`
  (in-process ssh2: `tcpip-forward`, `forwardOut` сервера → эхо-«sshd», порт занят внешним туннелем и перехват, отказ
  сервера, sshd выключен). Настоящие `win`/`winfs` и ПК не трогаются.
- Не проверено (только на ПК): реальный Windows OpenSSH Server, сосуществование с внешним туннелем (`ssh -R`), sshfs через туннель
  приложения, отключение при закрытии окна.

### Проброс портов VM → ПК (BACKLOG 10, 2026-11-09)
- Агент: `cclib/netstat.py` — разбор `/proc/net/tcp{,6}`, inode → pid через `/proc/<pid>/fd` (только свои процессы),
  `PortScanner` (повторный обход fd только при изменении набора сокетов), метод `list_ports`, событие `ports_changed` (3 с).
- Main: `src/main/ports.ts` (`PortForwarder`): `ensure(vmPort)` → `net.createServer` на `127.0.0.1` ПК → `forwardOut`.
  IPC: `ports.state|forward|close|open` (`open` принимает `{vmPort}` или `{url}` localhost и сам открывает браузер),
  событие `ports.state`. Закреплённые — `settings.ports.pinned`, тост о новом порте — `settings.ports.notifyNew`.
- Renderer: вкладка «Порты» (`components/RightPanel/PortsPanel.tsx`), `lib/ports.ts` (открыть/пробросить + сообщения),
  `lib/portsNotify.ts` (какие новые порты показать), ссылки в xterm — `controller.ts` → `openLink`.
- Тесты: `agent/tests/test_ports.py` (фикстуры `/proc/net/tcp{,6}`, имена процессов, реальный `http.server` в фейковом
  проекте, событие), `tests/unit/ports.node.test.ts` (URL, выбор порта, форвардер на фейковом транспорте),
  `tests/unit/portsNotify.web.test.ts`, `tests/integration/ports.test.ts` (direct-tcpip через in-process ssh2, обрыв и
  переподключение, закрытие).
- Не проверено (только на ПК): открытие браузера Windows, реальные dev-серверы через туннель, занятые порты Windows
  (Hyper-V/WSL резервируют диапазоны — тогда будет «следующий свободный»).

### Пароль sudo через приложение (BACKLOG 11, 2026-11-14)
- Скрипт `agent/askpass.py` (stdlib, `#!/usr/bin/env -S python3 -I`) входит в бандл агента и ставится исполняемым
  (`0700`) в `~/.local/lib/claudespace/askpass.py`. Чтобы им пользоваться, в окружении должна быть строка
  `export SUDO_ASKPASS="$HOME/.local/lib/claudespace/askpass.py"` (например, в `~/.bashrc`;
  приложение само dotfiles не меняет). Скрипт сам падает обратно на GTK-окно, когда приложения нет.
- Агент: `cclib/askpass.py` — сокет `~/.cache/claudespace/run/askpass.sock`, методы `askpass_enable {enabled}` и
  `askpass_reply {id, password|null}` (оба только для main), события `askpass_request`, `askpass_done {id, reason}`;
  проверка «кто держит сокет» каждые 2 с (опрос `askpass`). Main: `src/main/askpass.ts` (`AskpassBroker`: включение
  при подключении, окно на передний план + уведомление, ответ), IPC `askpass.pending`, `askpass.reply`.
- Renderer: `askpass.ts` (события → очередь, ответ), `stores/askpass.ts`, `components/Overlays/AskpassDialog.tsx`,
  Настройки → «Пароль sudo».
- Проверить вручную на VM (локальный режим, `npm run dev:vm`): `SUDO_ASKPASS=~/.local/lib/claudespace/askpass.py sudo -A -k true`
  в терминале приложения — окно в приложении; без приложения — GTK-окно.
- Тесты: `agent/tests/test_askpass.py` (ответ, отмена, тайм-аут, прерванный sudo, очередь, права, uid клиента, мусорные
  кадры, запасной путь, несколько агентов, агент целиком — пароля нет в stderr), `tests/unit/askpass.web.test.ts`,
  `tests/unit/askpass.node.test.ts`, `tests/integration/askpass.test.ts` (установленный скрипт → Connection → ответ),
  шаг в e2e (`docs/screenshots/10-askpass.png`).
- Не проверено (только на ПК): вывод окна из трея/свёрнутого на передний план в Windows и уведомление; настоящий
  `sudo -A` с этим скриптом (тесты запускают скрипт так, как его запускает sudo, но без sudo).

### Этап 6 «Удобство»: трей, автозапуск, палитра, поиск по чатам (2026-11-14)
- **Трей** (`src/main/tray.ts`, `AppTray`): значок ◆ (оранжевый — на связи, серый — нет; PNG встроены в код, файлов
  в `resources` нет), меню «Показать/Скрыть окно», строка «VM: …», строка «ПК: …» (туннель/диски, если туннель
  не выключен), «Выход». Клик по значку — показать/скрыть. Настройка `tray.closeToTray` (по умолчанию вкл. только в
  Windows): крестик прячет окно, связь, туннель ПК, пробросы и уведомления работают; при первом закрытии —
  уведомление «работает в трее». Выход — только через `quitApp()` в `index.ts` (отключение своих дисков, закрытие
  пробросов, затем `app.quit()`; `before-quit` извне тоже проходит через него). Клик по уведомлению, запрос пароля
  sudo и второй запуск (`second-instance`) показывают окно и из трея.
- **Автозапуск**: `startup.autostart` (выкл.), `startup.startHidden` (вкл.: при автозапуске окно не показывается,
  аргумент `--hidden`). `app.setLoginItemSettings` вызывается только в собранном приложении в Windows; в dev и не в
  Windows переключатель неактивен с подсказкой (в dev `process.execPath` — `electron.exe`, Windows запускал бы голый
  Electron без приложения).
- **Палитра** (`Ctrl+K` вне терминала, `Ctrl+Shift+P`, `F1`) уже была (чаты, проекты, сессии, действия); добавлены
  префикс `?` и пункт «Искать «…» в тексте чатов», команды «Поиск по тексту чатов» и «Настройки: Пароль sudo».
- **Поиск по тексту чатов**: агент `cclib/search.py` (`Searcher`, свой поток, один поиск за раз), методы
  `search_chats {searchId, query, limit?, budgetSec?, archived?}` / `search_cancel`, события `search_hits`,
  `search_done`. Ищет только в запросах пользователя и текстовых ответах Claude (не в выводе инструментов, не в
  thinking), без учёта регистра (и кириллицы), новые чаты первыми; ≤ 50 чатов, ≤ 3 фрагмента на чат, ≤ 10 с.
  Файлы читаются построчно через `safe_open` (запрет-список и аудит-хук). Renderer: `lib/chatSearch.ts`,
  `stores/search.ts`, `components/Overlays/ChatSearch.tsx` (`Ctrl+Shift+H`, строка «Искать в тексте чатов…» в
  сайдбаре, палитра). ⏎/клик — чат в списке «Чаты» с превью справа, `Ctrl+⏎`/двойной клик — продолжить.
  На этой VM (31 транскрипт, 80 МБ) поиск — 0,7–1 с.
- **Темы**: не делались — уже есть светлая/тёмная/как в системе; своих палитр нет (не дёшево: нужны цвета терминала).
- Тесты: `agent/tests/test_search.py`, `tests/unit/search.web.test.ts`, `tests/unit/tray.node.test.ts`, шаги в e2e
  (поиск, закрытие в трей и показ окна).
- Не проверено (только на ПК): значок и меню трея Windows, клик по значку, выход из трея, второй запуск, запуск
  с `--hidden` (окно открывается из трея), автозапуск в собранном приложении (нужна сборка этапа 7).

### Этап 7 «Поставка»: установщик, автообновление, релизы (2026-11-14)
- **Сборка**: `electron-builder.yml` (appId `io.github.claudespace` = `APP_ID` в `src/shared/app.ts`: это AppUserModelID
  ярлыка, без совпадения уведомления Windows в установленном приложении не показываются; тест `updater.node.test.ts`
  сверяет). NSIS one-click, на пользователя (`%LOCALAPPDATA%\Programs\ClaudeSpace`, без UAC), ярлыки на рабочем столе
  и в «Пуске», данные `%APPDATA%\ClaudeSpace` при удалении остаются (та же папка, что и у dev-запуска).
  В `app.asar` — только `out/` и production-зависимости (`ssh2`, `ssh-config`, `zod`, `electron-updater`; всё, что
  нужно только renderer, — в `devDependencies`, vite собирает это в бандл). Бандл агента и `ptyhelper.py` — в
  `resources/` (`extraResources`), main берёт их из `process.resourcesPath`. Нативные модули не пересобираются
  (`npmRebuild: false`): у `ssh2` они необязательные, без них он работает на чистом JS.
- **Значок**: `build/icon.png` (512) и `build/icon.ico` (16–256) генерирует `npm run icon` (`scripts/make-icon.py`,
  только stdlib): ◆ цвета акцента на тёмном скруглённом квадрате.
- **Локально**: `npm run dist:dir` — распакованная сборка в `release/` для текущей ОС; `npx electron-builder --win --dir`
  на Linux тоже работает (без wine), а NSIS-установщик на Linux требует wine — его собирает CI на Windows.
  `npm run dist:win` — установщик (на Windows). Запускать собранное на VM — только с фейковым HOME и `CLAUDESPACE_USER_DATA`
  (в локальном режиме оно подключится к настоящему tmux и агенту пользователя).
- **Автообновление** (`src/main/updater.ts`, electron-updater): только в собранном приложении (NSIS в Windows или AppImage).
  Проверка через 15 с после запуска и каждые 6 ч (если `updates.auto`), скачивание в фоне, затем карточка
  «Доступна версия X — Перезапустить и обновить / Позже» (`UpdateNotice.tsx`); «Позже» = установка при выходе
  (`autoInstallOnAppQuit`). «Перезапустить» сначала делает уборку `quitApp` (`cleanupForQuit`: отключение своих дисков
  ПК, закрытие пробросов, трей), потом `quitAndInstall(тихо, запустить после)`; если установщик не стартовал за 8 с —
  приложение перезапускается. Настройки → «О программе»: версия, состояние, «Проверить обновления», переключатель
  автопроверки, ошибки. В dev — «в dev-режиме обновления отключены». Лог — строки `[update]` в `main.log`.
  Релизы не подписаны: `publisherName` нет, `verifyUpdateCodeSignature: false` — подпись не проверяется.
  IPC: `update.state|check|install`, событие `update.state`.
- **Репозиторий** для публикации и для обновлений берётся из `package.json` → `repository.url`
  (`https://github.com/dZatr1k/ClaudeSpace.git`); electron-builder записывает его в `resources/app-update.yml`.
  Сменился репозиторий — поменять только это поле (CI проверяет, что оно совпадает с репозиторием, где идёт сборка).
- **Настройки без личных значений**: `integrations.rdpScript` по умолчанию пуст (кнопка RDP предлагает открыть
  Настройки → Интеграции), `pcLink.mounts` — пустой список. Существующие `settings.json` не ломаются: `Store` всегда
  пишет файл целиком, поэтому заданные значения лежат в нём явно и сохраняются (тест в `settings.node.test.ts`).
  Если файла не было (настройки ни разу не менялись), путь RDP и диск ПК нужно один раз указать в Настройках.

## Выпуск релиза

1. Рабочее дерево чистое, проверки проходят (`npm run typecheck && npm run lint && npm test`).
2. `npm run release -- 0.2.0` (`scripts/release.mjs`): ставит версию в `package.json`/`package-lock.json`,
   делает коммит `Release v0.2.0` и тег `v0.2.0`. **Ничего не пушит** — печатает команду.
3. `git push origin main v0.2.0` — тег запускает `.github/workflows/release.yml`: тесты на Ubuntu → сборка
   установщика на `windows-latest` и публикация в GitHub Releases (сразу опубликован, не черновик) вместе с
   `latest.yml` → AppImage на Ubuntu в тот же релиз. Тег должен совпадать с версией в `package.json`, иначе сборка падает.
4. Установленные приложения увидят версию при следующей проверке (запуск или раз в 6 ч) или по кнопке.

CI (`.github/workflows/ci.yml`): на push/PR в `main` — typecheck, lint, тесты агента, vitest, build (Ubuntu).

Не проверено (только на Windows / после первого релиза): установка и SmartScreen, значок exe и ярлыков, уведомления
с AppUserModelID `io.github.claudespace`, автозапуск из установленного приложения, полный цикл обновления
(скачивание, «Перезапустить и обновить», установка при выходе из трея), сборка в GitHub Actions.
