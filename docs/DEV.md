# ClaudeSpace — разработка

Состояние: этапы 0–4, 6, 7 (кроме проверок на Windows), 2026-11-15.

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

## Загрузочный экран отдельно от приложения
`npm run splash` поднимает Vite на `127.0.0.1:5180` (порт меняет `SPLASH_PORT`) со страницей
`src/renderer/splash/preview.html`. Слева сам экран (`Splash.tsx` + `splash.css`, правки видны сразу), справа панель:
прогон подключения, отдельные состояния, тема, размер окна. Состояние хранится в адресе (`?s=offline&theme=light`),
так что ссылка воспроизводит вид. В сборку приложения страница не попадает.

## Тесты

| Команда | Что | Сколько |
|---|---|---|
| `npm run test:agent` | агент: unittest (stdlib), фейковый HOME, реальный tmux на отдельном сокете `claudespace-test-py-*` | 90 |
| `npm run test:unit` | vitest: unit (hostkey, rpc, keymap, format, stores, terminals, settings, ports, askpass, search, tray…) + integration | 110 |
| `npm test` | оба набора | 200 |
| `npm run mobile:core` | ядро приложения для телефона на Kotlin (`mobile/core`) на JVM: юнит-тесты и настоящий агент за встроенным SSH-сервером MINA SSHD; нужен JDK 21 | 37 |
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
- **Список проектов** (`projects.project_dirs`): `~/projects/*`, папки чатов, `~` и папки, созданные через
  «Создать проект» (`~/.local/state/claudespace/created-projects.json`; удалённые папки выпадают из списка и из файла
  при следующем создании). `cc` знает только первые три источника, поэтому такие папки он не показывает, пока в них
  нет чата. `~` в путях раскрывается от домашней папки агента (`expand_home`), а не от `$HOME` процесса.
- **Скрипты-помощники** `askpass.py` (sudo) и `openurl.py` (`BROWSER`) ставятся вместе с агентом и говорят с ним
  через сокеты `~/.cache/claudespace/run/*.sock` (`cclib/appsock.py`: папка 0700, сокет 0600, только тот же uid,
  новый агент забирает общий сокет у старого). Если к VM подключено несколько приложений, запрос переходит к тому,
  из чьего терминала он пришёл (раздел «Несколько приложений на одной VM»).
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
- **Размер renderer** (замер 2026-11-16): бандл не минифицирован (так electron-vite делает по умолчанию), 3,0 МБ.
  Минификация дала бы 1,6 МБ и около 20 мс на компиляции JS при запуске (79 → 58 мс на VM). На фоне подключения по
  SSH это незаметно, а стеки ошибок renderer в `main.log` стали бы нечитаемыми, поэтому сборка оставлена как есть.
  Больше всего весят react-dom (525 КБ), xterm (415 КБ), highlight.js (229 КБ, только нужные языки) и zod (185 КБ).
- **Файлы userData**: `settings.json`, `workspace.json` (вкладки tmux, активная, размеры панелей, окно),
  `cache/snapshot.json` (последние списки — сайдбар заполнен сразу при запуске), `known_hosts` (TOFU приложения),
  `logs/main.log` (ротация 5×1 МБ). Для тестов путь переопределяется `CLAUDESPACE_USER_DATA`.

## Что не проверено

Обновлено 2026-11-18. С 09.11 приложение каждый день работает на ПК пользователя через настоящий SSH (ssh-agent
Windows, `~/.ssh/config`, known_hosts), поэтому прежние пункты про «реальный SSH» и «Windows не запускалось» сняты.
Проверено на ПК: подключение и переподключение, вкладки tmux с настоящим Claude Code, уведомления Windows, трей,
RDP, проброс портов и туннель, askpass, автообновление, загрузочный экран, вставка картинок через Ctrl+V,
WebGL-рендер терминала (0.7.2, см. ниже), сворачиваемые группы на экране «Настройки Claude» (0.7.5),
Markdown с таблицами GFM и шапкой YAML (0.7.6, `components/ui/Markdown.tsx`, плагин `remark-gfm`), файлы в чат
(0.7.9: PDF перетаскиванием из Проводника, `.md` через «Прикрепить» и диалог Windows, Claude прочитал PDF по пути).

Осталось:
- **OSC 52 из tmux copy-mode в буфер Windows**: обработчик есть (addon-clipboard → `clipboard.write`), в `~/.tmux.conf`
  на VM может понадобиться `set -as terminal-features ',xterm-256color:clipboard'` (не трогали). Обходной путь:
  `Shift+drag` и `Ctrl+C`.
- **Вкладки «Файлы» и «Git» на Windows**: проверены в e2e на VM, на ПК пользователь ещё не смотрел (диалог
  сохранения, «Показать в папке», перетаскивание файлов на папку).
- Вставка 1 МБ через UI и рост памяти renderer при `yes` проверены только на уровне main, в окне не профилировались.
- **Несколько чатов на экране, графики «Расход»** (2026-11-14): проверены e2e на VM. На ПК не проверено, не занят
  ли Ctrl+Alt+← / → самой Windows или драйвером видеокарты (на некоторых ноутбуках так поворачивают экран).
- **Полоска «Действия с Claude», экран «Настройки Claude», задачи в worktree, владелец «Диска ПК»** (2026-11-14):
  проверены тестами агента, интеграционными и e2e на VM с поддельным Claude. Пользователь проверил полоску на ПК с
  настоящим Claude Code (2026-11-15): `/compact`, `/clear`, `/model` и «Прервать» работают.
  Недописанный текст в поле ввода агент находит на экране панели (`cclib/claudeinput.py`: строка «❯» между двумя
  линиями, серый текст — подсказка) и прячет через Ctrl+S (stash Claude Code), Claude Code возвращает его после
  команды. Проверено вручную на 2.1.325 с `/clear`; на ПК пользователь ещё не смотрел.
- **Ссылки из чатов** (0.7.10): настоящий клик по ссылке в Claude Code на ПК, см. «Ссылки из чатов» ниже.

### WebGL-рендер терминала (BACKLOG 6, 2026-11-15)
- Причина мелких букв: canvas в Electron 45 не принимает `font` с пробелом в начале и оставляет «10px sans-serif»,
  а xterm 6 собирает шрифт атласа как `${italic} ${weight} …` (для прямого начертания строка начинается с пробела).
  Буквы выходили на 2/3 ячейки на любой машине, на VM это видно под SwiftShader.
- Исправление: `lib/canvasFont.ts` обрезает пробелы в сеттере `font`. Самопроверки остались страховкой и меряют
  высоту букв, а не ширину строки (ширина почти не меняется: буквы стоят по ячейкам): скрытый терминал
  (`[webgl-probe]`) и первый видимый настоящий (`[webgl-live]`, с размерами ячейки и холста).
- Проверка с WebGL: `E2E_GL=1 DISPLAY=:10 npx playwright test tests/e2e/webgl.spec.ts`.
- На ПК проверено 2026-11-15 на 0.7.2: буквы нормального размера, пользователь работает с WebGL.

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
- Тост о новом порте (2026-11-16, после ложных тостов «Новый порт 45687 (vitest, …)» от тестов): агент помечает
  `ephemeral` порты из диапазона `/proc/sys/net/ipv4/ip_local_port_range` (их ядро выдаёт на `listen(0)`, так
  работают тестовые и служебные серверы), для них тоста нет, в панели «Порты» они остаются. Остальные предлагаются,
  только если порт прослушивается 5 с тем же процессом (`PortAnnouncer`, `SETTLE_MS`), и один раз на порт и проект
  за 30 минут (`REOFFER_MS`), чтобы перезапуск dev-сервера при сохранении не повторял тост.
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

### Файлы в чат (BACKLOG 15, 2026-11-18)

- Claude Code работает на VM и видит только файлы VM, поэтому файл с ПК сначала загружается туда, а в поле ввода
  вставляется путь. Картинку по пути Claude Code превращает во вложение, путь к любому другому файлу остаётся текстом,
  и Claude читает файл инструментом Read (PDF, текст, код).
- Откуда: Ctrl+V с картинкой в буфере (`image.pasteClipboard`, только картинки), перетаскивание на терминал и
  «Прикрепить» (полоска Claude, `Ctrl+Shift+A`, палитра, ПКМ в терминале). «Прикрепить» открывает скрытый
  `<input type="file" multiple>` из renderer, как вкладка «Файлы»: main не получает от renderer путей на ПК и не читает
  файлы сам. Байты идут через `attach.upload` (zod: имя до 255 символов, данные до `FILE_UPLOAD_MAX` = 100 МБ).
- `src/main/attach.ts`: тип картинки определяется по сигнатуре, не по имени. Картинка → `~/.cache/claudespace/images/
  img-<sha16>.<ext>` (до 20 МБ, как раньше), остальное → `~/.cache/claudespace/files/<sha16>/<имя>`. Папки 0700,
  файлы 0600, тот же файл второй раз не загружается (только `touch`), файлы старше 7 дней и пустые папки удаляются
  при следующей загрузке. `attachName` оставляет в имени буквы любого алфавита, цифры, `.`, `_`, `-` (остальное → `_`,
  расширение сохраняется), поэтому путь вставляется без кавычек; в команду shell имя попадает через `shq`.
- Ctrl+V с файлами, скопированными в Проводнике, не поддержан: буфер Electron 45 (`clipboard.read()`) отдаёт текст и
  картинки, а список файлов Windows (CF_HDROP) из него не прочитать без проверки на ПК.
- Тесты: `tests/unit/attach.node.test.ts` (имена, папки и права, повтор, очистка, имя с символами shell, лимиты),
  `keymap.web.test.ts` (`Ctrl+Shift+A` в обеих раскладках), e2e (`smoke.spec.ts`: «Прикрепить» → диалог → два файла
  на VM и пути в терминале).

### Ссылки из чатов (BACKLOG 16, 2026-11-19)

- Claude Code сам обрабатывает клик по ссылке (мышь в tmux включена) и открывает её программой из `$BROWSER`, а без
  неё через `xdg-open` (так в 2.1.328). На VM без рабочего стола это не получалось, и Claude Code писал «Couldn't
  open your browser». Страница на ПК при этом открывалась: ту же ссылку видит xterm (web-links).
- Чаты, которые запускает приложение (`tmux.claude_command`), получают `BROWSER=~/.local/lib/claudespace/openurl.py`.
  Скрипт отправляет адрес в сокет агента `~/.cache/claudespace/run/openurl.sock`, агент шлёт событие
  `open_url {url}`, renderer открывает его через `openLink`, как клик в терминале: `localhost` через проброс порта,
  остальное через `shell.openExternal`.
- Одна и та же ссылка в течение 3 с открывается один раз (`openedRecently` в `lib/ports.ts`), потому что клик по
  адресу доходит и до xterm, и до Claude Code.
- Агент принимает только `http(s)` без пробелов и управляющих символов, до 4096 символов и не больше 10 ссылок за
  10 с, сам адрес в журнал не пишет. Сокет устроен так же, как у askpass (`cclib/appsock.py`), но работает всё время,
  пока работает агент, то есть пока подключено приложение. Значит, любая программа на VM от имени пользователя может
  открыть страницу в браузере ПК (так же устроен `BROWSER` в VS Code Remote).
- Без приложения скрипт запускает `xdg-open` на рабочем столе VM, если есть `DISPLAY`, и убирает `BROWSER` из
  окружения, чтобы `xdg-open` не вызвал скрипт снова. Иначе выходит с кодом 1, и Claude Code пишет прежнее сообщение.
- Ограничения. Чаты, запущенные до обновления или не из приложения (например, через `cc`), `BROWSER` не получают,
  пока их не перезапустить. С `BROWSER` Claude Code считает, что браузер есть, поэтому `/login` и вход в MCP по OAuth
  открывают страницу на ПК; переход оттуда на `localhost:<порт>` VM не дойдёт, и войти можно по адресу с вводом кода,
  который Claude Code показывает следом.
- Тесты: `agent/tests/test_openurl.py` (скрипт и сервер, отказ не-http, лимит, запасной путь без петли, uid,
  команда чата), `tests/unit/openLink.web.test.ts` (одна вкладка на клик, `localhost`, мусорные события),
  `tests/integration/openurl.test.ts` (установленный скрипт → агент → событие в main).
- Не проверено: настоящий клик в Claude Code на ПК; длинный адрес, который Claude Code перенёс на вторую строку
  (xterm может увидеть его обрезанным, и тогда откроются две вкладки).

### Несколько приложений на одной VM (этап 8, шаг 2, 2026-11-19)

К одной VM могут быть подключены сразу ПК, телефон и dev-копия. У каждого свой агент, а сокеты скриптов-помощников и
папка агента общие. Раньше запрос пароля sudo и ссылку получало приложение, которое подключилось последним, а
установщик менял агента на свою версию, даже если на VM стоял более новый.

- **Чей запрос.** При каждом подключении main придумывает id приложения (16 hex-цифр, `Connection.appId`). Агент
  получает его как `csagent.py serve --app <id>`, терминалы приложения экспортируют `CLAUDESPACE_APP=<id>` перед
  `tmux attach` и в обычном shell (`terminalCommand`). В окружение самого агента id не попадает: иначе его унаследовал
  бы сервер tmux, запущенный агентом, и все панели.
- **Как выбирается приложение** (`agent/cclib/route.py`). Скрипт отправляет свои `$TMUX`, `$TMUX_PANE` и
  `$CLAUDESPACE_APP`. Если он запущен в tmux, решает клиент tmux, подключённый к сессии этой панели, с самой свежей
  активностью (`client_activity`, то есть тот, где пользователь последним печатал или кликал). Его
  `CLAUDESPACE_APP` агент читает из `/proc/<pid>/environ` клиента и берёт только эту переменную. Клиент без неё
  (`cc` по SSH) означает «ни одно приложение»: скрипт получает `unavailable` и действует как без ClaudeSpace. Вне
  tmux решает `$CLAUDESPACE_APP` самого скрипта. Если сессию никто не смотрит, запрос получает приложение, чьи
  клиенты tmux были активны последними. Если не за что зацепиться, отвечает агент, которого спросили.
- **Как запрос доходит** (`cclib/appsock.py`). Агент с id слушает ещё и свой сокет `<имя>.<id>.sock`, пока
  работает, а выключенный (например, askpass выключен в настройках) отвечает на нём `unavailable`. Держатель общего
  сокета спрашивает маршрутизатор и, если запрос чужой, отвечает `{"status": "redirect", "app": id}`. Скрипт
  повторяет запрос на сокете этого приложения. Если там никто не слушает (агент убит, файл остался), скрипт
  отправляет запрос на общий сокет с `"routed": true`, и держатель отвечает сам.
- **Агент не откатывается** (`installPlan` в `src/main/agent/installer.ts`). В `MANIFEST.json` теперь есть `app`,
  версия приложения из `package.json`. Если на VM стоит агент более новой версии с тем же протоколом, установщик его
  не трогает и запускает (в `main.log` строка `the agent on the VM is from a newer release`). Если протокол другой,
  подключение останавливается с просьбой обновить приложение. Отсюда правило: в пределах одного `PROTOCOL` агент
  только добавляет методы и поля, ломающее изменение поднимает `PROTOCOL`. `AGENT_VERSION` в агенте с первого
  релиза не менялся, поэтому сравнивается именно `app`.
- Сокет ссылок агент теперь включает до первых снимков, а не после: ссылка, по которой кликнули сразу после
  подключения, не теряется.
- Ядро приложения для телефона делает то же самое: передаёт агенту `--app` и экспортирует `CLAUDESPACE_APP` в своих
  терминалах (`mobile/core`, раздел «Ядро на Kotlin»).
- Тесты: `agent/tests/test_route.py` (решение маршрутизатора; перенаправление между двумя серверами настоящими
  скриптами, включая askpass, «ни одно приложение», пропавшее и выключенное приложение; настоящие клиенты tmux через
  pty с `CLAUDESPACE_APP` и без; два процесса агента), `tests/unit/installer.node.test.ts`,
  `tests/unit/terminals.node.test.ts`, `tests/integration/local.test.ts` (более новый агент остаётся, другой протокол
  отклоняется, старый заменяется).
- Не проверено: ПК и телефон вместе на настоящей VM. Пока нет этапов 4 и 5, приложение для телефона к VM не
  подключается.

## Приложение для Android (этап 8)

План и решения: [MOBILE.md](MOBILE.md). Сделан этап 1 (2026-11-19): каркас, который собирается в APK и пока только
показывает свою версию. Этап 3 (2026-11-20): ядро на Kotlin в `mobile/core`, в APK оно пока не входит (раздел
«Ядро на Kotlin» ниже).

- **Инструменты.** JDK 21 и Android SDK (платформа 36, build-tools 35 и 36). На этой VM они стоят в
  `~/.local/opt/jdk-21` и `~/.local/opt/android-sdk`, без sudo. `scripts/mobile.mjs` берёт их из `JAVA_HOME` и
  `ANDROID_HOME`, а без этих переменных ищет в `~/.local/opt` и `~/Android/Sdk`.
- **Команды.** `npm run mobile:dev` отдаёт веб-часть на `127.0.0.1:5181` (порт меняет `MOBILE_PORT`), её смотрят в
  браузере в режиме телефона. `npm run mobile:apk` собирает веб-часть (`vite.mobile.config.ts`, в `out/mobile`),
  копирует её в проект Android (`cap sync android`) и запускает Gradle. APK с отладочной подписью ложится в
  `out/android/ClaudeSpace-<версия>-debug.apk`. Первая сборка скачивает Gradle и зависимости в `~/.gradle` (около
  1 ГБ) и идёт несколько минут. Демон Gradle после локальной сборки выходит через 10 минут простоя.
- **Что где.** Веб-часть в `src/mobile/`, цвета и шрифты общие с ПК (`src/renderer/theme/tokens.css` и
  `theme.css`). Конфиг Capacitor в `capacitor.config.json`. Проект Android в `mobile/android/`: его создал
  `npx cap add android` из Capacitor 8.6.0, дальше он поправлен руками. Версия берётся из `package.json` (0.7.10
  становится versionCode 7010), Firebase и примеры тестов убраны, значки свои (`npm run icon`), стартовый экран
  цвета фона приложения, `allowBackup="false"`, FileProvider открывает только папку снимков камеры, у дистрибутива
  Gradle указана контрольная сумма. Файлы `capacitor.build.gradle`, `capacitor.settings.gradle`,
  `app/src/main/assets/` и папку `capacitor-cordova-android-plugins/` Capacitor пересоздаёт при `cap sync`, их не
  правят.
- **Android 8 и новее** (`minSdkVersion = 26` в `mobile/android/variables.gradle`, у Capacitor по умолчанию 24): sshj
  разбирает ключи через `java.util.Base64`, которого нет в Android 7.
- **Подпись** пока только отладочная. Отладочный ключ на каждой машине свой, поэтому APK из CI не встанет поверх
  APK, собранного на VM: сначала нужно удалить старый. Ключ для релизов появится на этапе 6.
- **CI.** Задача `android` в `ci.yml` собирает APK на каждый push в `main` и хранит его артефактом 14 дней.
- **Телеметрия Capacitor CLI** включается сама при первом запуске `cap` в интерактивном терминале. На этой VM она
  выключена (`npx cap telemetry off`), на новой машине это нужно сделать до первой сборки. Без терминала и в CI CLI
  ничего не отправляет.
- **На телефон** отладочный APK проще всего забрать из Termux: `scp <user>@<vm>:<repo>/out/android/<apk>
  ~/storage/downloads/` (один раз перед этим `termux-setup-storage`), затем открыть файл в «Загрузках».
- Проверено 2026-11-19: APK ставится и запускается на телефоне пользователя, экран с версией виден. Отдельно не
  смотрели значок в лаунчере, стартовый экран и отступы под системные панели (на Android 15 и новее приложение
  рисуется под ними, отступы задаёт `SystemBars` из Capacitor).

### Ядро на Kotlin (этап 8, шаг 3, 2026-11-20)

Ядро повторяет main с ПК: подключение по SSH, проверку ключа сервера, установку агента, канал агента, терминалы и
переподключение. Это отдельная сборка Gradle в `mobile/core` (Kotlin 2.4, байткод Java 17), Android ей не нужен.
Своей обёртки Gradle у неё нет: `npm run mobile:core` запускает `mobile/android/gradlew -p mobile/core test`. Первый
запуск скачивает Kotlin и зависимости в `~/.gradle`. Служба Android подключит ядро как included build на этапе 5.

| Файл | Что делает | На ПК |
|---|---|---|
| `Connection.kt` | цикл подключения в корутине: настройки, SSH, ключ сервера, агент, online; ping агента раз в `keepaliveSec`, без ответа за три интервала соединение рвётся; повтор через 1/2/4/8/16/30 с ±20 %. `stop()` не блокирует, каналы закрываются в фоне | `connection.ts` |
| `ConnState.kt` | состояния; `toJson()` даёт ту же форму, что `ConnState` в `src/shared/model.ts`, чтобы интерфейс остался общим | `shared/model.ts` |
| `SshTransport.kt` | sshj. Канал читают два потока, `pause()` останавливает чтение: окно SSH заполняется, и удалённая сторона ждёт. `installSecurity()` ставит полный BouncyCastle вместо урезанного провайдера «BC» в Android | `transport/ssh.ts` |
| `SshKey.kt` | ключ ed25519 приложения в формате OpenSSH (openssh-key-v1 без шифрования), тот же текст читает `ssh-keygen`. Шифровать его на телефоне через Android Keystore будет служба (этап 5) | `ssh/auth.ts` |
| `KnownHosts.kt` | свой known_hosts приложения (TOFU), разбор как на ПК; изменённый ключ не добавляется никогда | `ssh/hostkey.ts` |
| `Installer.kt` | `probe`, `installPlan`, загрузка по SFTP, проверка sha256 на VM, замена папки. Бандл агента задаёт `AgentBundle`: в тестах это папка, в APK будут assets | `agent/installer.ts` |
| `AgentRpc.kt` | JSON Lines: запросы по id с таймаутом, события. Методов агента ядро не разбирает, параметры и результаты проходят как JSON | `agent/rpc.ts` |
| `Terminals.kt` | команды терминалов с `CLAUDESPACE_APP`, пачки по 8 мс, пауза после 1 МБ без подтверждений | `terminals.ts` |

- **Тесты** в `mobile/core/src/test/`. Юнит-тесты повторяют случаи `hostkey`, `installer`, `terminals` и `rpc` с ПК,
  ключ проверяется настоящим `ssh-keygen` в обе стороны. Интеграционные (`SshIntegrationTest`, `SshFailuresTest`)
  поднимают Apache MINA SSHD на `127.0.0.1` в фейковом HOME из `agent/tests/fixtures.py`: команды идут через bash,
  PTY даёт `resources/ptyhelper.py` (размер окна приходит ему через FIFO на fd 3), SFTP работает поверх того же HOME.
  Проверяются TOFU, установка по SFTP с правами файлов, повторное подключение без переустановки, более новый агент
  остаётся, агент на другом протоколе просит обновить приложение, `--app` у агента и `CLAUDESPACE_APP` у клиента tmux,
  ресайз и отсоединение, поток без подтверждений, обрыв сети, зависший агент (SIGSTOP), чужой ключ, VM без tmux.
- Бандл агента для тестов собирается в `mobile/core/build/agent-bundle` (`build_manifest.py --out`), а не в
  `resources/agent`: иначе тесты ядра и vitest переписывали бы одну папку одновременно. tmux работает на сокете
  `claudespace-test-kt-<pid>`, `~/.ssh` и установленный агент тесты не трогают.
- Для тестов нужны JDK 21, python3, tmux, `ssh-keygen` и git. В CI они идут в задаче `android` перед сборкой APK.
- Не проверено: ядро внутри приложения на Android (замена провайдера BouncyCastle, sshj в процессе приложения) и
  подключение к настоящему OpenSSH: тесты подключаются к MINA SSHD. Это проверится на телефоне на этапе 5.

## Выпуск релиза

1. Рабочее дерево чистое, проверки проходят (`npm run typecheck && npm run lint && npm test`).
2. `npm run release -- 0.2.0` (`scripts/release.mjs`): ставит версию в `package.json`/`package-lock.json`,
   делает коммит `Release v0.2.0` и тег `v0.2.0`. **Ничего не пушит** — печатает команду.
3. `git push origin main v0.2.0` — тег запускает `.github/workflows/release.yml`: тесты на Ubuntu → сборка
   установщика на `windows-latest` и публикация в GitHub Releases (сразу опубликован, не черновик) вместе с
   `latest.yml` → AppImage на Ubuntu в тот же релиз. Тег должен совпадать с версией в `package.json`, иначе сборка падает.
4. Установленные приложения увидят версию при следующей проверке (запуск или раз в 6 ч) или по кнопке.

CI (`.github/workflows/ci.yml`): на push/PR в `main` — typecheck, lint, тесты агента, vitest, build (Ubuntu) и
отладочный APK для Android (артефакт `ClaudeSpace-android-debug`).

Не проверено (только на Windows / после первого релиза): установка и SmartScreen, значок exe и ярлыков, уведомления
с AppUserModelID `io.github.claudespace`, автозапуск из установленного приложения, полный цикл обновления
(скачивание, «Перезапустить и обновить», установка при выходе из трея), сборка в GitHub Actions.
