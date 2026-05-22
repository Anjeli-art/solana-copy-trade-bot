import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";

type CalendarInputProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  allowClear?: boolean;
};

const monthFormatter = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric"
});
const weekdayLabels = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateValue(value: string) {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

function formatDisplayDate(date: Date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getFullYear()}`;
}

function sameDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function getCalendarDays(monthDate: Date) {
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const startDate = new Date(firstDay);
  startDate.setDate(firstDay.getDate() - startOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + index);
    return date;
  });
}

export function CalendarInput({ label, value, onChange, allowClear = true }: CalendarInputProps) {
  const selectedDate = parseDateValue(value);
  const [isOpen, setIsOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => selectedDate || new Date());
  const containerRef = useRef<HTMLLabelElement | null>(null);
  const days = useMemo(() => getCalendarDays(visibleMonth), [visibleMonth]);

  useEffect(() => {
    if (selectedDate) {
      setVisibleMonth(selectedDate);
    }
  }, [value]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  function shiftMonth(delta: number) {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  }

  function selectDate(date: Date) {
    onChange(toDateInputValue(date));
    setIsOpen(false);
  }

  const today = new Date();

  return (
    <label className="calendar-input" ref={containerRef}>
      <span>{label}</span>
      <button
        className={`calendar-trigger ${isOpen ? "open" : ""}`}
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <CalendarDays size={16} />
        <strong>{selectedDate ? formatDisplayDate(selectedDate) : "Date"}</strong>
      </button>
      {isOpen ? (
        <div className="calendar-popover">
          <div className="calendar-toolbar">
            <button type="button" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
              <ChevronLeft size={17} />
            </button>
            <strong>{monthFormatter.format(visibleMonth)}</strong>
            <button type="button" aria-label="Next month" onClick={() => shiftMonth(1)}>
              <ChevronRight size={17} />
            </button>
          </div>
          <div className="calendar-weekdays">
            {weekdayLabels.map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {days.map((date) => {
              const dateValue = toDateInputValue(date);
              const isOutsideMonth = date.getMonth() !== visibleMonth.getMonth();
              const isSelected = selectedDate ? sameDay(date, selectedDate) : false;
              const isToday = sameDay(date, today);

              return (
                <button
                  className={[
                    isOutsideMonth ? "muted" : "",
                    isSelected ? "selected" : "",
                    isToday ? "today" : ""
                  ].filter(Boolean).join(" ")}
                  type="button"
                  key={dateValue}
                  onClick={() => selectDate(date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="calendar-footer">
            <button type="button" onClick={() => selectDate(today)}>
              Today
            </button>
            {allowClear ? (
              <button type="button" onClick={() => {
                onChange("");
                setIsOpen(false);
              }}>
                <X size={14} />
                Clear
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </label>
  );
}
