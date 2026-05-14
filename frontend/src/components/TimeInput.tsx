import { Clock, X } from "lucide-react";

type TimeInputProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
};

function normalizeTimeInput(rawValue: string) {
  const digits = rawValue.replace(/\D/g, "").slice(0, 4);
  if (digits.length <= 2) {
    return digits;
  }

  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

function isValidTime(value: string) {
  if (!value) return true;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

export function TimeInput({ label, value, onChange }: TimeInputProps) {
  const isInvalid = !isValidTime(value);

  return (
    <label className="time-input">
      <span>{label}</span>
      <div className={`time-input-control ${isInvalid ? "invalid" : ""}`}>
        <Clock size={16} />
        <input
          aria-label={label}
          inputMode="numeric"
          maxLength={5}
          placeholder="--:--"
          type="text"
          value={value}
          onBlur={() => {
            if (isInvalid) {
              onChange("");
            }
          }}
          onChange={(event) => onChange(normalizeTimeInput(event.target.value))}
        />
        {value ? (
          <button type="button" aria-label={`Clear ${label}`} onClick={() => onChange("")}>
            <X size={14} />
          </button>
        ) : null}
      </div>
    </label>
  );
}
