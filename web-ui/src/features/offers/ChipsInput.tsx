import { useState, type KeyboardEvent } from 'react';
import { Chip } from '../../ui/Chip';
import type { FieldControl } from '../../ui/Field';
import styles from './Offers.module.css';

type Props = { control: FieldControl; values: string[]; onChange: (values: string[]) => void; placeholder?: string };

/** Words as chips: Enter or a comma adds what is typed, each chip has its remove button. */
export function ChipsInput({ control, values, onChange, placeholder }: Props) {
  const [text, setText] = useState('');
  const add = () => {
    const v = text.trim().replace(/,$/, '').trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    }
  };
  return (
    <div className={styles.chips}>
      {values.map((v) => (
        <Chip key={v} onRemove={() => onChange(values.filter((x) => x !== v))}>
          {v}
        </Chip>
      ))}
      <input {...control} className="input" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={add} />
    </div>
  );
}
