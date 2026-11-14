// sudo password prompt (BACKLOG 11). The input is uncontrolled: the password never enters React/zustand state; on
// submit it is read from the DOM, the field is cleared and the value goes to main (IPC askpass.reply).
import { KeyRound } from 'lucide-react';
import { useRef, useState } from 'react';
import type { AskpassRequest } from '@shared/askpass';
import { ASKPASS_MAX_PASSWORD } from '@shared/askpass';
import { answerAskpass } from '../../askpass';
import { t } from '../../i18n/ru';
import { shortPath } from '../../lib/format';
import { useAskpass } from '../../stores/askpass';
import { useData } from '../../stores/data';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

function Prompt({ req, queued }: { req: AskpassRequest; queued: number }) {
  const input = useRef<HTMLInputElement>(null);
  const [caps, setCaps] = useState(false);
  const home = useData((d) => d.hello?.home ?? null);
  const submit = () => {
    const el = input.current;
    if (!el) return;
    const pw = el.value;
    el.value = '';
    void answerAskpass(req.id, pw);
  };
  const cancel = () => {
    if (input.current) input.current.value = '';
    void answerAskpass(req.id, null);
  };
  return (
    <Modal
      open
      onClose={cancel}
      title={
        <span className="flex items-center gap-2">
          <KeyRound size={15} className="text-st-waiting" />
          {t.askpass.title}
        </span>
      }
      width={520}
      footer={
        <>
          {queued > 0 && (
            <span className="mr-auto self-center text-[12px] text-faint">{t.askpass.queued(queued)}</span>
          )}
          <Button onClick={cancel} data-testid="askpass-cancel">
            {t.actions.cancel}
          </Button>
          <Button variant="primary" onClick={submit} data-testid="askpass-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="text-[13px] text-muted">
        {req.session ? t.askpass.whoSession(req.session) : t.askpass.who}
      </div>
      <pre
        className="selectable mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[6px] border border-line bg-base p-2 font-mono text-[12px] text-fg"
        data-testid="askpass-command"
      >
        {req.command || t.askpass.unknownCommand}
      </pre>
      {req.cwd && <div className="mt-1 truncate text-[12px] text-faint">{shortPath(req.cwd, home)}</div>}
      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={input}
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          maxLength={ASKPASS_MAX_PASSWORD}
          placeholder={req.prompt}
          aria-label={req.prompt}
          data-testid="askpass-input"
          className="h-8 w-full rounded-[4px] border border-line-strong bg-base px-2 text-[13px] outline-none focus:border-accent"
          onKeyUp={(e) => setCaps(e.getModifierState('CapsLock'))}
        />
      </form>
      <div className="mt-1.5 flex justify-between text-[12px] text-faint">
        <span>{t.askpass.hint}</span>
        {caps && <span className="text-st-waiting">{t.askpass.caps}</span>}
      </div>
    </Modal>
  );
}

export function AskpassDialog() {
  const queue = useAskpass((s) => s.queue);
  const req = queue[0];
  if (!req) return null;
  // key: a fresh (empty) input for every prompt
  return <Prompt key={req.id} req={req} queued={queue.length - 1} />;
}
