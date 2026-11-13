import { useEffect, useMemo, useRef } from 'react';
import type { SlideFigure } from '../io/pptx';

/** pptx の中に Cocat の図が 2 つ以上あるとき、開く図を選ぶ（docs/reopen-figure.md）。選ばずに閉じれば onPick(null) */
export function SlideFigurePicker({ fileName, figures, onPick }: { fileName: string; figures: SlideFigure[]; onPick(f: SlideFigure | null): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const picked = useRef<SlideFigure | null>(null);
  const urls = useMemo(() => figures.map((f) => URL.createObjectURL(new Blob([f.png as BlobPart], { type: 'image/png' }))), [figures]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="about slide-figures" data-testid="slide-figures" onClose={() => onPick(picked.current)}>
      <h2>スライドの図を選ぶ</h2>
      <p className="muted">{`${fileName} の中に、Cocat で作った図が ${figures.length} つあります。開く図を選んでください。今の図と置き換わり、元に戻すと前の図に戻ります。`}</p>
      <ul className="slide-figure-list">
        {figures.map((f, i) => (
          <li key={f.media}>
            <button
              type="button"
              data-testid="slide-figure"
              onClick={() => {
                picked.current = f;
                ref.current?.close();
              }}
            >
              <img src={urls[i]} alt="" />
              <span>{f.slides.length ? `スライド ${f.slides.join('・')}` : 'どのスライドにも無い図'}</span>
            </button>
          </li>
        ))}
      </ul>
      <form method="dialog" className="row">
        <button type="submit">やめる</button>
      </form>
    </dialog>
  );
}
