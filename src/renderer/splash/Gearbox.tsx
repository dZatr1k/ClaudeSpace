// Gearbox loader. Adapted from Uiverse.io by Nawsome ("fresh-panther-41", MIT, github.com/uiverse-io/galaxy):
// recoloured with the app's tokens, both themes, can pause (offline) and stop (done). Styles: gearbox.css.
import './gearbox.css';

const BARS = { small: 3, large: 6 } as const;

function Gear({ pos, large }: { pos: 'one' | 'two' | 'three' | 'four'; large?: boolean }) {
  return (
    <div className={`cs-gear cs-gear--${pos} ${large ? 'is-large' : ''}`}>
      <div className="cs-gear__inner">
        {Array.from({ length: large ? BARS.large : BARS.small }, (_, i) => (
          <div key={i} className="cs-gear__bar" />
        ))}
      </div>
    </div>
  );
}

export function Gearbox({
  state = 'run',
  accent = false,
}: {
  state?: 'run' | 'paused' | 'done';
  accent?: boolean;
}) {
  return (
    <div className={`cs-gearbox is-${state} ${accent ? 'has-accent' : ''}`} aria-hidden>
      <div className="cs-gearbox__overlay" />
      <Gear pos="one" />
      <Gear pos="two" />
      <Gear pos="three" />
      <Gear pos="four" large />
    </div>
  );
}
