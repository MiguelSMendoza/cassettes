import { useEffect, useRef, useId } from "react";
import { X } from "lucide-react";
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const backdropPointer = useRef<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    el?.showModal();
    return () => {
      el?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const outside =
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom;
        backdropPointer.current =
          e.target === e.currentTarget && outside ? e.pointerId : null;
      }}
      onPointerUp={(e) => {
        const startedOutside = backdropPointer.current === e.pointerId;
        backdropPointer.current = null;
        const r = e.currentTarget.getBoundingClientRect();
        if (
          startedOutside &&
          e.target === e.currentTarget &&
          (e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom)
        )
          onClose();
      }}
      onPointerCancel={() => {
        backdropPointer.current = null;
      }}
    >
      <div className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Cerrar"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
