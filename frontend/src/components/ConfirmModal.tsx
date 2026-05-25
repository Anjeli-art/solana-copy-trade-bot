import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

type ConfirmModalProps = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmModal({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
  onCancel
}: ConfirmModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    }
    // Defer by one tick so the keypress/click that opened the modal
    // doesn't immediately trigger the Enter handler.
    const timer = window.setTimeout(() => {
      window.addEventListener("keydown", onKey);
    }, 50);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onConfirm, onCancel]);

  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div className={`modal-card confirm-card ${variant === "danger" ? "danger" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon" aria-hidden="true">
          {variant === "danger" ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
        </div>
        <div className="modal-copy">
          <p className="modal-title">{title}</p>
          {description && <p className="modal-description">{description}</p>}
        </div>
        <div className="modal-actions">
          <button className="modal-cancel" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`modal-confirm ${variant === "danger" ? "danger" : ""}`}
            type="button"
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
