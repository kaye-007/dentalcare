import { useEffect, useState, type InputHTMLAttributes } from 'react';
import { moneyInputValue, parseMoney } from '@dentalcare/shared';

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'inputMode'
> & {
  /** Minor units (cents). Zero and null both show as an empty field. */
  value: number | null;
  /** Minor units, or null when the text is empty or is not an amount. */
  onChange: (minor: number | null) => void;
};

/** Zero and empty are the same thing to a money field. */
const same = (a: number | null, b: number | null) => (a ?? 0) === (b ?? 0);

/**
 * A money field that speaks minor units.
 *
 * `<input type="number">` was the wrong control for money twice over: it
 * handed back a float, and in many locales it refuses the comma someone types
 * as a decimal mark. This keeps the text the person typed and reports cents,
 * parsed exactly by the shared parseMoney — "37,50" and "37.50" both mean
 * 3750.
 */
export default function MoneyInput({ value, onChange, ...rest }: Props) {
  const [text, setText] = useState(() => (value ? moneyInputValue(value) : ''));

  // Follow a value set from outside — a price filled in from the catalogue —
  // but leave the text alone while what is typed already means that value.
  // Otherwise "37," would be rewritten to "37" mid-keystroke, and a field
  // someone has just cleared would snap back to "0".
  useEffect(() => {
    setText((current) => {
      const typed = parseMoney(current);
      if (current.trim() === '' ? same(null, value) : typed !== null && same(typed, value)) {
        return current;
      }
      return value ? moneyInputValue(value) : '';
    });
  }, [value]);

  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseMoney(e.target.value));
      }}
    />
  );
}
