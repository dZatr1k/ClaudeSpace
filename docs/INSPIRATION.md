# Референсы для ClaudeSpace

Собрано 2026-11-08. Цель — выбрать, что нравится по виду и по способу работы. Статусы проектов — по данным
поиска, перед заимствованием идей проверить на самой странице.

## Обёртки для Claude Code (ближе всего по функциям)

| Проект | Что это | Чем интересен |
|---|---|---|
| [opcode](https://github.com/winfunc/opcode) (бывш. Claudia) | Tauri 2, самый известный GUI для Claude Code | список проектов из `~/.claude/projects`, сессии с первым сообщением и временем, resume/fork, редактор CLAUDE.md, usage, свои агенты |
| [CloudCLI / claudecodeui](https://github.com/siteboon/claudecodeui) | веб + мобильный UI, активно развивается | управление сессиями удалённо, мобильная вёрстка — референс для этапа 8 |
| [simple-code-gui](https://github.com/DonutsDelivery/simple-code-gui) | десктоп: сайдбар проектов + вкладки терминалов | почти ровно наша идея; разработка на паузе |
| [claude-session-manager (nobel6018)](https://github.com/nobel6018/claude-session-manager) | Tauri + React | поиск и продолжение старых чатов |
| [claude-code-gui (markes76)](https://github.com/markes76/claude-code-gui) | обёртка над CLI | экраны для CLAUDE.md, памяти, MCP, skills, hooks — идеи для «Настроек Claude» |
| [claude-code-gui (5Gears0Chill)](https://github.com/5Gears0Chill/claude-code-gui) | Tauri + React | встроенный терминал, аналитика usage, мониторинг сессий |

## Параллельные агенты (идеи для статусов и навигации)

| Проект | Что это | Чем интересен |
|---|---|---|
| [Conductor](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/) | закрытое Mac-приложение | эталон по полировке: список агентов слева, у каждого статус, diff и merge |
| [Crystal](https://github.com/ianva/crystal) | Electron, сессии в git worktree | по данным одного обзора устарел (02.2026), но UI полезно посмотреть |
| [emdash](https://github.com/michabbb/emdash), Daintree, Orchestra | Electron-оболочки над несколькими CLI-агентами | вкладки терминалов + статусы агентов |
| [Обзор инструментов 2026 (рус.)](https://agentsroom.dev/ru/blog/best-multi-agent-coding-tools) | сравнение | быстро пробежаться по скриншотам |

## Терминалы и SSH-клиенты (вид терминала, вкладки, палитра)

| Проект | Чем интересен |
|---|---|
| [Tabby](https://github.com/Eugeny/tabby) | Electron + xterm.js, менеджер SSH-подключений, вкладки — ближе всего по технологии |
| [Termius](https://termius.com/blog/termius-x) | горизонтальные вкладки, «хранилища», командная палитра, SFTP рядом с терминалом |
| [Wave Terminal](https://github.com/wavetermdev/waveterm) | блоки-виджеты: терминал, превью файлов, браузер в одном окне |
| [Warp](https://docs.warp.dev/getting-started/quickstart/customizing-warp/) | современный вид, блоки команд, палитра |

## Что выбрать

Достаточно 1–3 ссылок с пометкой, что именно нравится (раскладка, цвета, вкладки, сайдбар, статусы).

## Выбрано (2026-11-08): opcode + simple-code-gui

Разбор, что берём и что нет, — в [DESIGN.md §1](DESIGN.md#1-референсы-opcode-и-simple-code-gui).

| Проект | Лицензия | Код | Заметки по виду |
|---|---|---|---|
| opcode | **AGPL-3.0** | не брать (копилефт) — только идеи и UX | скриншотов в репозитории нет (видео в README, на opcode.sh — только обложка); по коду: Tauri 2, Tailwind 4 + Radix + lucide, почти чёрный фон `oklch(0.10 0.01 240)`, Inter, вкладки разных типов вместо сайдбара, карточки сессий, свой чат-рендер поверх `stream-json` |
| simple-code-gui (DonutCode) | **PolyForm Noncommercial 1.0.0** (не open source) | не брать — только идеи и UX | скриншоты `assets/main.png`, `main tabbed.png`, `settings 1/2.png`: сайдбар проектов ~280 px с цветными категориями и аватарами, вкладки терминалов с точкой статуса, плиточный режим, плотная тёмная вёрстка, акцент «Claude Orange», настройки модальным окном с превью тем. Разработка на паузе с 09.2026 |
