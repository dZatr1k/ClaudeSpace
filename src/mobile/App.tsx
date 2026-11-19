// Stage 1 of docs/MOBILE.md: a build that only proves the app installs and starts on the phone.
export function App() {
  return (
    <div className="safe h-full">
      <main className="flex h-full flex-col justify-center px-6">
        <div className="flex items-center gap-3">
          <span aria-hidden className="text-2xl text-accent">
            ◆
          </span>
          <h1 className="text-2xl font-semibold">ClaudeSpace</h1>
        </div>
        <p className="mt-2 text-muted">Версия {__APP_VERSION__}</p>
        <p className="mt-6 max-w-sm leading-relaxed">
          Эта сборка проверяет, что приложение ставится и запускается на телефоне. Подключение к VM появится в
          следующих сборках.
        </p>
      </main>
    </div>
  );
}
