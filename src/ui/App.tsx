import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { track } from '../analytics';
import { getLlmSettings, subscribeLlmSettings } from '../llm/settings';
import { schemeFromDrawing } from '../scheme/ops';
import { EntryCards, SideHome } from './SideHome';
import { rectUnion, type P, type Rect } from '../chem/geometry';
import { parseLabel } from '../chem/label';
import { edit } from '../chem/model';
import { setAbbr, setColor } from '../chem/ops';
import * as actions from '../editor/actions';
import { handleKey } from '../editor/keys';
import '../editor/tools2';
import '../editor/tools3';
import { alignCenters } from '../chem/align';
import { cleanStructure } from '../chem/clean';
import { setText } from '../chem/schemeOps';
import { ExportDialog, IoPanel } from './IoPanel';
import { fragmentOf, selectionFrame } from '../editor/tools2';
import { kindOf } from '../chem/model';
import { AnalysisPanel } from './AnalysisPanel';
import { LibraryPanel } from './LibraryPanel';
import { ProjectStore } from '../project/store';
import { placeCompound } from '../project/library';
import { activeSchemeId, SchemePanel } from './SchemePanel';
import { RunDock, RunSummary } from './RunDock';
import { createRun } from '../process/ops';
import { NextStepGhost, SchemeEditPopover } from './OnCanvasEditors';
import type { SchemeTarget } from '../scheme/pick';
import { TablePanel } from './TablePanel';
import { SAMPLES } from '../samples';
import { About } from './About';
import { LlmSettings } from './LlmSettings';
import { TextToSchemePanel } from './TextToSchemePanel';
import { NamePanel } from './NamePanel';
import { EditorStore, useEditor } from '../editor/store';
import { canonical, documentSmiles } from '../io/smiles';
import { Canvas, MAX_ZOOM, MIN_ZOOM, type View } from './Canvas';
import { DOC_EXT, loadAutosave, parseDocFile, saveAutosave, serializeDoc } from '../io/docfile';
import { baseNameOf, fileNameFor } from '../io/filename';
import { emptyDoc } from '../chem/model';
import { canGroupSalt, canUngroupSalt, groupSalt, saltLabelProblem, ungroupSalt } from '../chem/salt';
import { setStereoGroup } from '../chem/stereoGroups';
import { PAGE_SIZES, pagesBox } from '../chem/page';
import { layout } from '../render/layout';
import { download } from './IoPanel';
import { TOOL_GROUPS, toolHint, Toolbar } from './Toolbar';
import { Menu, PopupMenu, type MenuEntry, type MenuItem } from './Menu';
import { AbbrDictionary } from './AbbrDictionary';
import { applyAbbrs, setDocAbbrs, withUsedAbbrDefs } from './abbrStore';
import { subscribeAbbrs } from '../chem/abbreviations';
import { ToolsResize, useToolsWidth } from './ToolsResize';
import { TextFormatBar, wrapSelection } from './TextFormatBar';
import { DrawStyleDialog } from './DrawStyleDialog';
import { PageSetupDialog } from './PageSetupDialog';
import { printDoc } from '../io/print';

declare global {
  interface Window {
    __editor?: EditorStore;
    __canon?: (s: string) => string | null;
  }
}

interface Overlay {
  kind: 'label' | 'text';
  id: string | null;
  at: P;
  value: string;
  /** 文字: 化学式の書き方（英字のあとの数字を下付き。CH2Cl2 → CH₂Cl₂）。新しい文字ははじめ入り */
  formula?: boolean;
}

export function App() {
  // 前回の続き（ブラウザに自動保存した文書）から始める
  const store = useMemo(() => new EditorStore(loadAutosave() ?? undefined), []);
  const doc = useEditor(store, (s) => s.doc);
  const isEmpty = !Object.keys(doc.atoms).length && !Object.keys(doc.arrows).length && !Object.keys(doc.texts).length && !Object.keys(doc.pluses).length;
  const canUndo = useEditor(store, (s) => s.past.length > 0);
  const canRedo = useEditor(store, (s) => s.future.length > 0);
  const selection = useEditor(store, (s) => s.selection);
  const toolsWidth = useToolsWidth();
  const fileName = useEditor(store, (s) => s.fileName ?? '');
  const tool = useEditor(store, (s) => s.tool);
  const partName = useEditor(store, (s) => s.part?.name ?? '');
  const message = useEditor(store, (s) => s.message);
  const [showAbbrDict, setShowAbbrDict] = useState(false);
  // 略号の辞書: 利用者の辞書と、開いた文書が持つ辞書を引けるようにする。変わったら図を描き直す
  useEffect(() => setDocAbbrs(doc.abbrDefs), [doc.abbrDefs]);
  useEffect(() => {
    applyAbbrs();
    return subscribeAbbrs(() => store.set({ doc: { ...store.get().doc } }));
  }, [store]);
  // 使った利用者の略号は、文書にも写す（別の PC で開いても読めるように）
  useEffect(() => {
    const next = withUsedAbbrDefs(doc);
    if (next !== doc) store.set({ doc: next });
  }, [doc, store]);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 2.5 });
  const projects = useMemo(() => new ProjectStore(), []);
  useEffect(() => {
    void projects.init();
  }, [projects]);
  const [showLibrary, setShowLibrary] = useState(() => {
    try {
      // はじめての人には部品を減らして見せるので、開いたことがあるときだけ開く
      return localStorage.getItem('ai-chem-editor:library') === 'open';
    } catch {
      return false;
    }
  });
  const toggleLibrary = () =>
    setShowLibrary((v) => {
      try {
        localStorage.setItem('ai-chem-editor:library', v ? 'closed' : 'open');
      } catch {
        // 覚えられなくても開閉はできる
      }
      return !v;
    });
  const stageRef = useRef<HTMLElement>(null);
  /** 表示の中央（文書の座標） */
  const viewCenter = () => {
    const el = stageRef.current;
    const w = el?.clientWidth ?? 800;
    const h = el?.clientHeight ?? 600;
    return { x: view.x + w / view.zoom / 2, y: view.y + h / view.zoom / 2 };
  };
  /** 描いた物の全体が表示に収まるように、位置と拡大率を合わせる（拡大は 250% まで） */
  const fitView = (d = store.get().doc) => {
    // ページの設定があれば、ページ全体（とページの外にはみ出した図）が入るように
    const content = layout(d).bbox;
    const box = d.page ? (content ? rectUnion(pagesBox(d.page), content) : pagesBox(d.page)) : content;
    const el = stageRef.current;
    if (!box || !el) return setView((v) => ({ ...v, x: 0, y: 0 }));
    const pad = 16;
    const w = el.clientWidth;
    // 下の端は、今の道具の案内と拡大・縮小が重なるので、その分を空ける
    const below = 48;
    const h = Math.max(120, el.clientHeight - below);
    const z = Math.min(2.5, Math.max(MIN_ZOOM, Math.min(w / (box.x2 - box.x1 + pad * 2), h / (box.y2 - box.y1 + pad * 2))));
    setView({ zoom: z, x: (box.x1 + box.x2) / 2 - w / z / 2, y: (box.y1 + box.y2) / 2 - h / z / 2 });
  };
  const zoom = view.zoom;
  /** 今の表示の範囲（文書の座標）。書き出しの欄で、表示の外にある物を数えるのに使う */
  const visibleRect: Rect | null = stageRef.current
    ? { x1: view.x, y1: view.y, x2: view.x + stageRef.current.clientWidth / zoom, y2: view.y + stageRef.current.clientHeight / zoom }
    : null;
  const setZoom = (f: (z: number) => number) => setView((v) => ({ ...v, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, f(v.zoom))) }));
  const fileRef = useRef<HTMLInputElement>(null);
  const [showStereo, setShowStereo] = useState(false);
  // NMR の予測の行を指したときに、キャンバスで強く示す原子
  const [nmrMarks, setNmrMarks] = useState<string[]>([]);
  const [showAbout, setShowAbout] = useState(false);
  const [showLlm, setShowLlm] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [showDrawStyle, setShowDrawStyle] = useState(false);
  const [showPageSetup, setShowPageSetup] = useState(false);
  // 右の欄に出す物。タブは無く、選んだ物か、押したボタンで替わる
  const [side, setSideRaw] = useState<SideView>('home');
  /** 開いている実験の記録（下の表の欄と、右の欄に出す） */
  const [runId, setRunId] = useState<string | null>(null);
  /** 下の表の欄を畳んでいる */
  const [dockClosed, setDockClosed] = useState(false);
  // 右の欄は畳める（キャンバスを広く使うため）。畳んだことはブラウザに置く
  const [sideOpen, setSideOpenRaw] = useState(() => {
    try {
      return localStorage.getItem('ai-chem-editor:side') !== 'closed';
    } catch {
      return true;
    }
  });
  const setSideOpen = (open: boolean) => {
    setSideOpenRaw(open);
    try {
      localStorage.setItem('ai-chem-editor:side', open ? 'open' : 'closed');
    } catch {
      // 置けなくても、開いている間は畳める
    }
  };
  /** メニューやボタンから欄を出す。畳んであれば開く */
  const setSide = (v: SideView) => {
    setSideRaw(v);
    setSideOpenRaw(true);
  };
  const llm = useSyncExternalStore(subscribeLlmSettings, getLlmSettings);
  const hasKey = !!llm.apiKey;
  /** AI の欄の使い方（作る・直す・書く・仕上げ）。直す・書く・仕上げは、スキームの欄の「AI で」から開く */
  const [aiMode, setAiMode] = useState<AiMode>('create');
  const openAi = (mode: AiMode = 'create') => {
    if (!getLlmSettings().apiKey) return setShowLlm(true);
    setAiMode(mode);
    setSide('ai');
  };
  const schemeCount = Object.keys(doc.schemes ?? {}).length;
  // 選んだ物で欄を替える。作業の欄（AI・名前・読み書き・新しいスキーム）は、選んでも替えない（下書きの化合物を選ぶなど）
  useEffect(() => {
    if (!selection.size) return;
    const d = store.get().doc;
    let next: SideView = 'analysis';
    for (const id of selection) {
      const ref = d.atoms[id]?.ref?.split(':')[0] ?? d.arrows[id]?.ref ?? d.texts[id]?.ref ?? d.pluses[id]?.ref;
      const runRef = d.shapes?.[id]?.ref ?? d.arrows[id]?.ref ?? d.texts[id]?.ref;
      if (runRef && d.runs?.[runRef]) {
        next = 'run';
        setRunId(runRef);
        break;
      }
      if (ref && d.schemes?.[ref]) next = 'scheme';
      else if (ref && d.tables?.[ref]) next = 'table';
      if (next !== 'analysis') break;
    }
    setSideRaw((cur) => {
      // 分子の欄は、選んだ物（スキームの化合物も）の分子量などを見るので、選んでも替えない
      if (cur === 'ai' || cur === 'name' || cur === 'io' || cur === 'new-scheme' || (cur === 'analysis' && next !== 'run')) return cur;
      // スキーム・検討表の欄で分子を選ぶのは、その欄で使うため（生成物にする、母核にする）
      if ((cur === 'scheme' || cur === 'table') && next === 'analysis') return cur;
      return next;
    });
  }, [selection, store]);
  // 新しいスキームの欄でスキームを作ったら、そのスキームの欄にする
  const schemeCountRef = useRef(schemeCount);
  useEffect(() => {
    if (schemeCount > schemeCountRef.current && side === 'new-scheme') setSideRaw('scheme');
    schemeCountRef.current = schemeCount;
  }, [schemeCount, side]);
  /** 描いた反応式（スキームにしていない分子と矢印）があれば、キャンバスの上に「スキームにする」を出す */
  const drawnReaction = useMemo(() => {
    if (!Object.values(doc.arrows).some((a) => !a.ref)) return null;
    try {
      return schemeFromDrawing(doc) ? Object.values(doc.arrows).filter((a) => !a.ref).map((a) => a.id).join(',') : null;
    } catch {
      return null;
    }
  }, [doc]);
  /** 下書きのスキームで、確かめてほしい所のある化合物の印（右上の位置・文・原子） */
  const issueMarks = useMemo(() => {
    const out: { key: string; x: number; y: number; text: string; atoms: string[] }[] = [];
    for (const sc of Object.values(doc.schemes ?? {})) {
      if (!sc.draft) continue;
      const byCompound = new Map<string, string[]>();
      for (const i of sc.draft.issues) if (i.compoundId) byCompound.set(i.compoundId, [...(byCompound.get(i.compoundId) ?? []), i.message]);
      for (const [cid, texts] of byCompound) {
        const atoms = Object.values(doc.atoms).filter((a) => a.ref === `${sc.id}:${cid}`);
        if (!atoms.length) continue;
        out.push({ key: `${sc.id}:${cid}`, x: Math.max(...atoms.map((a) => a.x)), y: Math.min(...atoms.map((a) => a.y)), text: texts.join('\n'), atoms: atoms.map((a) => a.id) });
      }
    }
    return out;
  }, [doc]);
  const [dismissedReaction, setDismissedReaction] = useState<string | null>(null);
  // 描いた反応式が無くなったら（スキームにした・消した・新規）、閉じた印も消す
  useEffect(() => {
    if (!drawnReaction) setDismissedReaction(null);
  }, [drawnReaction]);
  /**
   * スキーム・検討表の物を選んで、その欄を出す。分子（原子）は選ばない。
   * 選んだ化合物は「AI で直す」で構造を書き換えてよい物として扱うので、一覧から開いただけで全部を選ばないため
   */
  const selectRef = (ref: string, view: SideView) => {
    const d = store.get().doc;
    let ids = [...Object.values(d.arrows).filter((a) => a.ref === ref).map((a) => a.id), ...Object.values(d.texts).filter((t) => t.ref === ref).map((t) => t.id)];
    if (!ids.length) ids = Object.values(d.atoms).filter((a) => a.ref?.split(':')[0] === ref).map((a) => a.id);
    store.set({ selection: new Set(ids) });
    setSide(view);
  };
  /** 実験の記録を開く: 下の表の欄と右の欄に出す */
  const openRun = (id: string) => {
    setRunId(id);
    setDockClosed(false);
    setSide('run');
  };
  /** 実験の記録を作って開く。スキームの段から作ると、その段の基質・試薬・溶媒が仕込みに入る */
  const newRun = (from?: { schemeId: string; stepIndex: number }) => {
    const first = Object.values(store.get().doc.schemes ?? {})[0];
    const r = createRun(store.get().doc, from ?? (first ? { schemeId: first.id, stepIndex: 0 } : undefined));
    store.commit(r.doc, new Set());
    track(from ? 'run:new-from-step' : 'run:new');
    openRun(r.runId);
    fitView(r.doc);
  };
  const openSample = (id: string) => {
    const s = SAMPLES.find((x) => x.id === id);
    if (!s) return;
    try {
      store.commit(s.build(), new Set());
      track(`sample:${s.id}`);
      fitView();
      store.set({ message: `見本「${s.name}」を開きました。元に戻すと前の図に戻ります` });
      // 見本の中身に合うタブを開く
      if (s.id === 'conditions' || s.id === 'sar') setSide('table');
      else if (s.id === 'coupling' || s.id === 'multistep') setSide('scheme');
      else if (s.id === 'run') openRun(Object.keys(store.get().doc.runs ?? {})[0]);
    } catch (err) {
      store.set({ message: String((err as Error).message ?? err) });
    }
  };

  // 変更のたびに、少し待ってからブラウザに自動保存する
  useEffect(() => {
    const t = setTimeout(() => saveAutosave(doc), 400);
    return () => clearTimeout(t);
  }, [doc]);

  const saveDoc = () => download(fileNameFor(store.get().fileName, DOC_EXT), serializeDoc(store.get().doc), 'application/json');
  const openDoc = async (f: File) => {
    try {
      store.commit(parseDocFile(await f.text()), new Set());
      store.set({ fileName: baseNameOf(f.name) });
      fitView();
    } catch (e) {
      store.set({ message: String((e as Error).message ?? e) });
    }
  };
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  /** キャンバスでドラッグなどをしている間（選んだ物の帯を隠す） */
  const [busy, setBusy] = useState(false);
  /** 図の上で直している段か化合物 */
  const [schemeEdit, setSchemeEdit] = useState<SchemeTarget | null>(null);
  const activeScheme = activeSchemeId(doc, selection);
  const activeRun = runId && doc.runs?.[runId] ? runId : null;
  const showDock = !!activeRun && !dockClosed && side === 'run';
  /** 右クリックのメニュー（画面の座標） */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  /** 「書き出す」の画面 */
  const [showExport, setShowExport] = useState<{ onlySelected: boolean } | null>(null);
  /** 選んだ物の帯の、色の一覧 */
  const [barColors, setBarColors] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const clean = () => {
    const s = store.get();
    const r = cleanStructure(s.doc, s.selection);
    store.commit(r.doc);
    if (r.failed) store.set({ message: `${r.failed} 個の分子を整えられませんでした` });
  };
  const align = (axis: 'h' | 'v') => {
    const s = store.get();
    store.commit(alignCenters(s.doc, s.selection, axis));
  };
  const openTextEditor = (id: string | null, at: P) => {
    const t = id ? store.get().doc.texts[id] : null;
    setOverlay({ kind: 'text', id, at: t ? { x: t.x, y: t.y } : at, value: t?.text ?? '', formula: t ? !!t.formula : true });
  };

  useEffect(() => {
    track('open', { once: true });
  }, []);

  useEffect(() => {
    window.__editor = store;
    window.__canon = canonical;
  }, [store]);

  const smiles = useMemo(() => {
    try {
      return documentSmiles(doc);
    } catch (e) {
      return { smiles: null, error: String(e) };
    }
  }, [doc]);

  const openLabelEditor = (atomId: string) => {
    const a = store.get().doc.atoms[atomId];
    if (!a) return;
    setOverlay({ kind: 'label', id: atomId, at: { x: a.x, y: a.y }, value: a.abbr ?? (a.element === 'C' ? '' : a.element) });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlay) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (k === 's' || k === 'o' || k === 'p')) {
        e.preventDefault();
        if (k === 's') saveDoc();
        else if (k === 'p') printDoc(store.get().doc, 'A4');
        else fileRef.current?.click();
        return;
      }
      // Shift+1: 図の全体を表示する（入力欄の中では効かない）
      const t = e.target as HTMLElement | null;
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Digit1' && !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) {
        e.preventDefault();
        fitView();
        return;
      }
      const handled = handleKey(store, e, {
        copy: () => actions.copy(store),
        cut: () => actions.cut(store),
        paste: () => actions.paste(store),
        pasteKey: () => actions.pasteKey(store),
        selectAll: () => actions.selectAll(store),
        clean,
        flip: (axis) => actions.flip(store, axis),
        openLabelEditor,
      });
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ほかのアプリからの貼り付け（SMILES・Molfile・CDXML の文字）。入力欄の中の貼り付けはそのまま
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (overlay || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      e.preventDefault();
      actions.pasteEvent(store, text);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  useEffect(() => {
    const el = overlay?.kind === 'text' ? textRef.current : inputRef.current;
    el?.focus();
    el?.select();
  }, [overlay?.id, overlay?.kind, overlay?.at.x, overlay?.at.y]);

  // Enter で確定したあと、入力欄が消えるときの blur でもう一度呼ばれるのを防ぐ
  const committed = useRef<Overlay | null>(null);
  const commitOverlay = () => {
    if (!overlay || committed.current === overlay) return;
    committed.current = overlay;
    const doc = store.get().doc;
    if (overlay.kind === 'label' && overlay.id) {
      const parsed = parseLabel(overlay.value);
      if (parsed?.kind === 'abbr') store.commit(setAbbr(doc, overlay.id, parsed.abbr));
      else if (parsed?.kind === 'element') {
        const id = overlay.id;
        const bad = parsed.salt && saltLabelProblem(doc, id, parsed);
        if (bad) store.set({ message: bad });
        else
          store.commit(
            edit(doc, (d) => {
              d.atoms[id].element = parsed.element;
              d.atoms[id].charge = parsed.charge;
              delete d.atoms[id].abbr;
              if (parsed.isotope) d.atoms[id].isotope = parsed.isotope;
              else delete d.atoms[id].isotope;
              if (parsed.salt) d.atoms[id].salt = { x: parsed.salt.x, style: parsed.salt.style };
              else delete d.atoms[id].salt;
            }),
          );
      } else if (overlay.value.trim()) store.set({ message: `「${overlay.value}」は元素記号にも略号にもありません` });
      // 入力欄がカーソルを覆って hover が外れるので、続けてキーで編集できるように戻す
      if (store.get().doc.atoms[overlay.id]) store.set({ hover: overlay.id });
    }
    if (overlay.kind === 'text') store.commit(setText(doc, overlay.id, overlay.at, overlay.value, !!overlay.formula));
    setOverlay(null);
  };

  // 操作の一覧。上のバーのメニュー、選んだ物の帯、右クリックのメニューで同じ物を使う
  const editItems: MenuEntry[] = [
            { label: '切り取り', shortcut: 'Ctrl+X', onClick: () => actions.cut(store) },
            { label: 'コピー', shortcut: 'Ctrl+C', onClick: () => actions.copy(store) },
            { label: '貼り付け', shortcut: 'Ctrl+V', title: 'ほかのアプリでコピーした SMILES・Molfile・CDXML も貼れます', onClick: () => actions.pasteMenu(store) },
            { label: '図を画像でコピー', title: '選んだ物を、Word や PowerPoint に貼れる画像でコピーする。何も選んでいなければ図の全体をコピーする', testId: 'copy-image', onClick: () => actions.copyImage(store) },
            { label: 'すべて選択', shortcut: 'Ctrl+A', onClick: () => actions.selectAll(store) },
            { sep: true },
            { label: '⇋ 左右反転', shortcut: 'Ctrl+Shift+H', onClick: () => actions.flip(store, 'h') },
            { label: '⇵ 上下反転', shortcut: 'Ctrl+Shift+V', onClick: () => actions.flip(store, 'v') },
  ];
  const arrangeItems: MenuEntry[] = [
            { label: 'Clean Structure', shortcut: 'Ctrl+Shift+K', title: '結合の長さと角度を整える', onClick: clean },
            { label: '横にそろえる', title: '選んだ物の中心の高さをそろえる。何も選んでいなければ全部をそろえる', onClick: () => align('h') },
            { label: '縦にそろえる', title: '選んだ物の中心の左右の位置をそろえる。何も選んでいなければ全部をそろえる', onClick: () => align('v') },
            { sep: true },
            { label: '略号を展開', title: 'Boc などの略号を原子と結合にする', onClick: () => actions.expandAbbrs(store) },
            { label: '略号に縮約', title: '展開した原子と結合を、元の略号に戻す', onClick: () => actions.contractAbbrs(store) },
            { sep: true },
            {
              label: '塩としてまとめる',
              testId: 'group-salt',
              title: '酸と塩基のように選んだ 2 つ以上の分子を、1 つの塩として扱う。分子の欄、スキーム、ライブラリでも 1 つの化合物になる',
              disabled: !canGroupSalt(doc, selection),
              onClick: () => (store.commit(groupSalt(store.get().doc, store.get().selection)), store.set({ message: '選んだ分子を 1 つの塩としてまとめました' })),
            },
            {
              label: 'まとまりを解く',
              testId: 'ungroup-salt',
              title: '塩としてまとめた分子を、別々の分子に戻す',
              disabled: !canUngroupSalt(doc, selection),
              onClick: () => store.commit(ungroupSalt(store.get().doc, store.get().selection)),
            },
            { heading: '立体の表し方: 選んだ不斉中心か分子に付ける' },
            {
              label: '絶対配置（abs）',
              testId: 'stereo-abs',
              title: '描いたくさびのとおりの立体。ふつうはこの書き方',
              disabled: !selection.size,
              onClick: () => store.commit(setStereoGroup(store.get().doc, store.get().selection, 'abs')),
            },
            {
              label: 'ラセミ（rac・&）',
              testId: 'stereo-and',
              title: '描いた立体とその鏡像の 1:1 の混合物。分子の下に rac と出し、一部の中心だけなら &1 と出す',
              disabled: !selection.size,
              onClick: () => store.commit(setStereoGroup(store.get().doc, store.get().selection, 'and')),
            },
            {
              label: '相対配置（rel・or）',
              testId: 'stereo-or',
              title: '描いた立体かその鏡像の一方で、どちらかは決まっていない。分子の下に rel と出し、一部の中心だけなら or1 と出す',
              disabled: !selection.size,
              onClick: () => store.commit(setStereoGroup(store.get().doc, store.get().selection, 'or')),
            },
  ];
  const colorItems: MenuEntry[] = COLORS.map(([name, hex]) => ({
    label: name,
    swatch: hex ?? '#000',
    testId: `color-${name}`,
    onClick: () => {
      const st = store.get();
      if (!st.selection.size) return store.set({ message: '色を変える物を選んでください' });
      store.commit(setColor(st.doc, st.selection, hex));
    },
  }));
  /** 右クリックのメニューと、選んだ物の帯の「ほかの操作」に出す項目 */
  const contextItems = (): MenuEntry[] => {
    const has = store.get().selection.size > 0;
    const pick = (items: MenuEntry[], labels: string[]) => items.filter((it): it is MenuItem => 'label' in it && labels.includes(it.label));
    if (!has)
      return [
        ...pick(editItems, ['貼り付け', 'すべて選択']),
        { sep: true },
        { label: '全体を表示', shortcut: 'Shift+1', onClick: () => fitView() },
        { label: '書き出す…', testId: 'ctx-export', onClick: () => setShowExport({ onlySelected: false }) },
      ];
    return [
      ...pick(editItems, ['切り取り', 'コピー', '貼り付け', '図を画像でコピー']),
      { sep: true },
      ...pick(arrangeItems, ['Clean Structure', '横にそろえる', '縦にそろえる', '略号を展開', '略号に縮約']),
      ...pick(arrangeItems, ['塩としてまとめる', 'まとまりを解く']).filter((it) => !it.disabled),
      { sep: true },
      { label: '選んだ物だけ書き出す…', testId: 'ctx-export', onClick: () => setShowExport({ onlySelected: true }) },
      { label: '分子量などを見る', testId: 'ctx-analysis', onClick: () => setSide('analysis') },
      ...(showLibrary ? [] : [{ label: 'ライブラリを開く', onClick: toggleLibrary }]),
    ];
  };
  // 下の表の欄を開くとキャンバスが低くなるので、図の全体が見えるように合わせ直す
  useEffect(() => {
    if (showDock) fitView();
    // 開いたときだけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDock]);
  /** 選んだ物の帯を出す所（キャンバスの左上からの px）。選択の道具で選んでいて、ドラッグしていないときだけ */
  const selBar = (() => {
    if (busy || overlay || schemeEdit || !selection.size || (tool !== 'select' && tool !== 'lasso')) return null;
    const r = selectionFrame(doc, selection);
    const el = stageRef.current;
    if (!r || !el) return null;
    const W = 300;
    const H = 34;
    // 枠の上の回転のつまみ（枠より 8 pt 上）のさらに上。上に入らなければ枠の下
    let top = (r.y1 - 8 - view.y) * zoom - 12 - H;
    if (top < 6) top = (r.y2 - view.y) * zoom + 8;
    if (top > el.clientHeight - H - 6) return null;
    const left = Math.max(6, Math.min((r.x1 - view.x) * zoom, el.clientWidth - W - 6));
    return { left, top };
  })();

  return (
    <div className={`app${showLibrary ? ' with-library' : ''}${sideOpen ? '' : ' side-closed'}`} style={toolsWidth.style}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">⌬</span>
          <h1>Cocat</h1>
          <span className="beta">ベータ</span>
        </div>
        <input
          className="doc-name"
          data-testid="doc-name"
          aria-label="文書の名前"
          title="保存と書き出しで使うファイルの名前"
          placeholder="名前のない文書"
          value={fileName}
          onChange={(e) => store.set({ fileName: e.target.value })}
        />
        <Menu
          label="ファイル"
          testId="menu-file"
          items={[
            { label: '新規', title: '空の文書にする。ページの設定は変えず、元に戻すと前の文書に戻る', onClick: () => (store.commit({ ...emptyDoc(), ...(doc.page ? { page: doc.page } : {}) }, new Set()), store.set({ fileName: '' })) },
            { label: '開く…', shortcut: 'Ctrl+O', title: `${DOC_EXT} の文書を開く`, onClick: () => fileRef.current?.click() },
            { label: '保存', shortcut: 'Ctrl+S', title: `文書を ${DOC_EXT} で保存する`, onClick: saveDoc },
            { label: 'SMILES・MOL・CDXML の読み込みと書き出し…', testId: 'open-io', onClick: () => setSide('io') },
            ...(doc.page
              ? [
                  {
                    label: `印刷・PDF（${PAGE_SIZES[doc.page.size].name}・${doc.page.cols * doc.page.rows} ページ）`,
                    shortcut: 'Ctrl+P',
                    title: 'ページを 1 枚ずつ、その大きさの紙に原寸で出す。印刷の画面で「PDF に保存」を選ぶと PDF になる',
                    testId: 'print-pages',
                    onClick: () => (printDoc(store.get().doc), track('print:pages')),
                  },
                ]
              : [
                  { label: '印刷・PDF（A4）', shortcut: 'Ctrl+P', title: '図を A4 の紙に収めて印刷する。印刷の画面で「PDF に保存」を選ぶと PDF になる', testId: 'print-a4', onClick: () => (printDoc(store.get().doc, 'A4'), track('print:a4')) },
                  { label: '印刷・PDF（レター）', title: '図をレターの紙に収めて印刷する', testId: 'print-letter', onClick: () => (printDoc(store.get().doc, 'Letter'), track('print:letter')) },
                ]),
            { sep: true },
            { heading: '見本を開く' },
            ...SAMPLES.map((s) => ({ label: s.name, testId: `sample-${s.id}`, onClick: () => openSample(s.id) })),
          ]}
        />
        <Menu label="編集" testId="menu-edit" items={editItems} />
        <Menu label="整える" testId="menu-arrange" items={arrangeItems} />
        <Menu
          label="表示"
          testId="menu-view"
          items={[
            { label: '全体を表示', shortcut: 'Shift+1', title: '図の全体が入るように合わせる', onClick: () => fitView() },
            { label: '拡大', onClick: () => setZoom((z) => Math.min(6, z + 0.5)) },
            { label: '縮小', onClick: () => setZoom((z) => (z > 1 ? z - 0.5 : z / 1.5)) },
            { sep: true },
            { label: showLibrary ? 'ライブラリを閉じる' : 'ライブラリを開く', onClick: toggleLibrary },
            { label: sideOpen ? '右の欄を畳む' : '右の欄を開く', onClick: () => setSideOpen(!sideOpen) },
          ]}
        />
        <input
          ref={fileRef}
          type="file"
          accept={`${DOC_EXT},application/json`}
          data-testid="open-doc"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openDoc(f);
            e.target.value = '';
          }}
        />
        <Menu label="色" testId="menu-color" title="選んだ原子・結合・矢印・文字・図形の色を変える" items={colorItems} />
        <span className="sep" />
        <button type="button" className="icon-text" onClick={() => store.undo()} disabled={!canUndo} title="元に戻す (Ctrl+Z)">
          ↶ 元に戻す
        </button>
        <button type="button" className="icon-text" onClick={() => store.redo()} disabled={!canRedo} title="やり直す (Ctrl+Y)">
          ↷ やり直す
        </button>
        <span className="sep" />
        <button type="button" className="icon-text" data-testid="open-name" onClick={() => setSide('name')} title="化合物名から構造を置く">
          名前から置く
        </button>
        {hasKey && (
          <button type="button" className="icon-text ai-button" data-testid="open-ai" onClick={() => openAi('create')} title="文章や図から、スキームの下書きを AI で作る">
            ✦ AI で作る
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="export-button" data-testid="open-export" onClick={() => setShowExport({ onlySelected: false })} title="図を SMILES・MOL・CDXML・CDX・SVG・PNG で書き出す。画像でのコピーもここから">
          書き出す
        </button>
        <Menu
          label="設定"
          testId="menu-settings"
          items={[
            { label: 'AI の設定…', testId: 'open-llm-settings', title: 'AI の会社とモデルを選び、API キーを入れる', onClick: () => (setShowLlm(true), track('llm:settings')) },
            { label: '図の設定…', title: '線の太さと文字の大きさを変える', testId: 'open-draw-style', onClick: () => setShowDrawStyle(true) },
            { label: 'ページの設定…', title: 'キャンバスの大きさを、A4 かスライドを何枚並べるかで決める', testId: 'open-page-setup', onClick: () => setShowPageSetup(true) },
            { label: '略号の辞書…', testId: 'open-abbr-dict', title: '標準の略号と自分で足した略号を見て、略号を足す。NHFmoc、CO2tBu、BF3K のようなラベルがどう読まれるかも試せる', onClick: () => setShowAbbrDict(true) },
          ]}
        />
        <Menu
          label="ヘルプ"
          testId="menu-help"
          items={[
            { label: 'キーの操作の一覧', testId: 'open-shortcuts', onClick: () => setShowKeys(true) },
            { label: 'このツールについて', testId: 'open-about', title: 'ベータ版について・データの扱い・感想の送り先', onClick: () => setShowAbout(true) },
          ]}
        />
      </header>
      {/* ダイアログは上のバーの外に置く（バーの文字の決まりを受け継がないように） */}
      {showLlm && <LlmSettings onClose={() => setShowLlm(false)} />}
      {showAbout && <About onClose={() => setShowAbout(false)} />}
      {showExport && <ExportDialog store={store} visibleRect={visibleRect} onlySelected={showExport.onlySelected} onCopyImage={() => actions.copyImage(store)} onClose={() => setShowExport(null)} />}
      {showKeys && <Shortcuts onClose={() => setShowKeys(false)} />}
      {showDrawStyle && <DrawStyleDialog store={store} onClose={() => setShowDrawStyle(false)} />}
      {showAbbrDict && <AbbrDictionary store={store} onClose={() => setShowAbbrDict(false)} />}
      {showPageSetup && <PageSetupDialog store={store} onClose={() => setShowPageSetup(false)} onApplied={() => fitView()} />}
      <Toolbar
        store={store}
        groups={TOOL_GROUPS}
        footer={
          <button
            type="button"
            className={`library-tab${showLibrary ? ' on' : ''}`}
            onClick={toggleLibrary}
            aria-pressed={showLibrary}
            aria-label={showLibrary ? 'ライブラリを閉じる' : 'ライブラリを開く'}
            data-testid="toggle-library"
            title="化合物・図・表・部品をしまうプロジェクトのライブラリを開く・閉じる"
          >
            <span aria-hidden="true">{showLibrary ? '◂' : '▸'}</span> ライブラリ
          </button>
        }
      />
      <ToolsResize width={toolsWidth.width} setWidth={toolsWidth.setWidth} />
      {showLibrary && <LibraryPanel store={store} projects={projects} viewCenter={viewCenter} />}
      <main className="stage" ref={stageRef}>
        <Canvas
          store={store}
          view={view}
          setView={setView}
          showStereo={showStereo}
          marks={nmrMarks}
          onDropCompound={(id, at) => {
            const c = projects.get().project?.compounds[id];
            if (!c) return;
            const { doc: d, ids } = placeCompound(store.get().doc, c, at);
            store.commit(d, ids);
            store.set({ tool: 'select' });
          }}
          onLabelEdit={openLabelEditor}
          onTextEdit={openTextEditor}
          onBusy={setBusy}
          onRunEdit={(id) => openRun(id)}
          onSchemeEdit={(t) => {
            if (store.get().doc.schemes?.[t.schemeId]?.pinned) return store.set({ message: '固定中のスキームです。直すときは、右の欄で固定を外してください' });
            setSchemeEdit(t);
            track(`scheme:edit-on-canvas-${t.kind}`, { once: true });
          }}
          onMenu={(at, hit) => {
            // 選んでいない物の上で押したら、その物（分子なら分子全体）を選んでからメニューを出す
            const st = store.get();
            if (hit && !st.selection.has(hit)) {
              const ids = kindOf(hit) === 'atom' || kindOf(hit) === 'bond' ? fragmentOf(st.doc, hit) : new Set([hit]);
              store.set({ selection: ids, tool: st.tool === 'lasso' ? 'lasso' : 'select' });
            } else if (!hit && st.selection.size) store.set({ selection: new Set() });
            setCtxMenu(at);
            track('menu:context', { once: true });
          }}
        />
        {selBar && (
          <div className="sel-bar" data-testid="sel-bar" style={selBar} role="toolbar" aria-label="選んだ物の操作">
            <button type="button" data-testid="sel-clean" title="結合の長さと角度を整える (Ctrl+Shift+K)" onClick={clean}>Clean</button>
            <button type="button" data-testid="sel-flip-h" title="左右反転 (Ctrl+Shift+H)" aria-label="左右反転" onClick={() => actions.flip(store, 'h')}>⇋</button>
            <button type="button" data-testid="sel-flip-v" title="上下反転 (Ctrl+Shift+V)" aria-label="上下反転" onClick={() => actions.flip(store, 'v')}>⇵</button>
            <span className="sep" />
            <button type="button" data-testid="sel-color" title="色を変える" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setBarColors({ x: r.left, y: r.bottom + 4 }); }}>色</button>
            <button type="button" data-testid="sel-copy-image" title="Word や PowerPoint に貼れる画像でコピーする" onClick={() => actions.copyImage(store)}>画像でコピー</button>
            <span className="sep" />
            <button type="button" data-testid="sel-more" title="ほかの操作" aria-label="ほかの操作" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCtxMenu({ x: r.left, y: r.bottom + 4 }); }}>⋯</button>
          </div>
        )}
        {schemeEdit && <SchemeEditPopover key={`${schemeEdit.kind}:${schemeEdit.schemeId}:${schemeEdit.kind === 'step' ? schemeEdit.stepIndex : schemeEdit.compoundId}`} store={store} target={schemeEdit} view={view} onClose={() => setSchemeEdit(null)} />}
        {side === 'scheme' && sideOpen && activeScheme && !busy && <NextStepGhost store={store} schemeId={activeScheme} view={view} />}
        {ctxMenu && <PopupMenu at={ctxMenu} label="操作" items={contextItems()} onClose={() => setCtxMenu(null)} testId="ctx-menu" />}
        {barColors && <PopupMenu at={barColors} label="色" items={colorItems} onClose={() => setBarColors(null)} testId="sel-colors" />}
        {isEmpty && <EntryCards onSample={openSample} onAi={() => openAi('create')} />}
        <div className="tool-hint" data-testid="tool-hint">{toolHint(tool, partName)}</div>
        <div className="status" data-testid="status" role="status" aria-live="polite" key={message}>{message}</div>
        <div className="stage-zoom" role="group" aria-label="拡大・縮小">
          <button type="button" data-testid="zoom-out" onClick={() => setZoom((z) => (z > 1 ? z - 0.5 : z / 1.5))} title="縮小" aria-label="縮小">
            −
          </button>
          <button type="button" className="zoom" data-testid="zoom-level" onClick={() => fitView()} title="図の全体が入るように合わせる">{Math.round(zoom * 100)}%</button>
          <button type="button" data-testid="zoom-in" onClick={() => setZoom((z) => Math.min(6, z + 0.5))} title="拡大" aria-label="拡大">
            ＋
          </button>
          <button type="button" data-testid="zoom-fit" onClick={() => fitView()} title="図の全体が入るように合わせる (Shift+1)">
            全体を表示
          </button>
        </div>
        {!sideOpen && (
          <button type="button" className="side-open" data-testid="side-open" onClick={() => setSideOpen(true)} title="右の欄を開く">
            <span aria-hidden="true">◂</span> {SIDE_TITLE[side === 'ai' ? (`ai-${aiMode}` as const) : side]}
          </button>
        )}
        {issueMarks.map((m) => (
          <button
            key={m.key}
            type="button"
            className="issue-mark"
            data-testid="issue-mark"
            style={{ left: (m.x - view.x) * zoom + 8, top: (m.y - view.y) * zoom - 22 }}
            title={m.text}
            aria-label={`確かめてほしい所: ${m.text}`}
            onClick={() => store.set({ selection: new Set(m.atoms) })}
          >
            !
          </button>
        ))}
        {drawnReaction && drawnReaction !== dismissedReaction && (
          <div className="from-drawing" data-testid="from-drawing">
            <span>描いた反応式を、条件・番号を直せるスキームにできます</span>
            <button
              type="button"
              className="primary"
              data-testid="from-drawing-apply"
              onClick={() => {
                const r = schemeFromDrawing(store.get().doc);
                if (!r) return;
                store.commit(r.doc, new Set());
                setSide('scheme');
                track('scheme:from-drawing-bar');
              }}
            >
              スキームにする
            </button>
            <button type="button" className="link" aria-label="閉じる" data-testid="from-drawing-close" onClick={() => setDismissedReaction(drawnReaction)}>
              ✕
            </button>
          </div>
        )}
        {overlay?.kind === 'text' && (
          <textarea
            ref={textRef}
            className="overlay-text"
            data-testid="text-input"
            style={{ left: (overlay.at.x - view.x) * zoom, top: (overlay.at.y - 10 - view.y) * zoom }}
            value={overlay.value}
            onChange={(e) => setOverlay({ ...overlay, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitOverlay();
              }
              if (e.key === 'Escape') setOverlay(null);
            }}
            onBlur={(e) => {
              // 下の書式のボタンを押したときは閉じない
              if (!(e.relatedTarget as HTMLElement | null)?.closest('.text-format')) commitOverlay();
            }}
          />
        )}
        {overlay?.kind === 'text' && (
          <TextFormatBar
            style={{ left: (overlay.at.x - view.x) * zoom, top: (overlay.at.y - 10 - view.y) * zoom + 50 }}
            formula={!!overlay.formula}
            onFormula={(formula) => (setOverlay({ ...overlay, formula }), textRef.current?.focus())}
            onWrap={(open, close) => {
              const el = textRef.current;
              if (!el) return;
              const { value, at } = wrapSelection(overlay.value, el.selectionStart, el.selectionEnd, open, close);
              // 描き直しを待たずに、すぐカーソルを置く。次のフレームまで待つと、そのあいだに打った文字がカッコの外に入った
              flushSync(() => setOverlay({ ...overlay, value }));
              el.focus();
              el.setSelectionRange(at, at);
            }}
          />
        )}
        {overlay?.kind === 'label' && (
          <input
            ref={inputRef}
            className="overlay-input"
            data-testid="label-input"
            style={{ left: (overlay.at.x - view.x) * zoom - 30, top: (overlay.at.y - view.y) * zoom - 14 }}
            value={overlay.value}
            onChange={(e) => setOverlay({ ...overlay, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitOverlay();
              if (e.key === 'Escape') setOverlay(null);
            }}
            onBlur={commitOverlay}
          />
        )}
      </main>
      {showDock && activeRun && <RunDock store={store} runId={activeRun} onClose={() => setDockClosed(true)} onOpenTable={() => setSide('table')} />}
      <aside className="side" hidden={!sideOpen}>
        <div className="side-head" data-testid="side-head" data-view={side}>
          <b>{SIDE_TITLE[side === 'ai' ? (`ai-${aiMode}` as const) : side]}</b>
          <span className="spacer" />
          {side !== 'home' && (
            <button
              type="button"
              className="link"
              data-testid="side-back"
              onClick={() => {
                // AI で直す・書く・仕上げは、スキームの欄に戻る。ほかは「この文書」に戻る
                if (side === 'ai' && aiMode !== 'create') return setSide('scheme');
                setSide('home');
              }}
            >
              {side === 'ai' && aiMode !== 'create' ? '← スキーム' : '← この文書'}
            </button>
          )}
          <button type="button" className="side-collapse" data-testid="side-collapse" onClick={() => setSideOpen(false)} title="右の欄を畳む" aria-label="右の欄を畳む">
            ▸
          </button>
        </div>
        <div className="side-body">
          <div className="tab-page" hidden={side !== 'home'} data-tab="home">
            <SideHome
              doc={doc}
              onNewScheme={() => setSide('new-scheme')}
              onNewTable={() => setSide('table')}
              onScheme={(id) => selectRef(id, 'scheme')}
              onTable={(id) => selectRef(id, 'table')}
              onMolecules={() => setSide('analysis')}
              onNewRun={() => newRun()}
              onRun={openRun}
            />
          </div>
          <div className="tab-page" hidden={side !== 'ai'} data-tab="ai">
            <TextToSchemePanel
              store={store}
              library={() => Object.values(projects.get().project?.compounds ?? {})}
              onOpenSettings={() => setShowLlm(true)}
              onCreated={() => fitView()}
              mode={aiMode}
            />
          </div>
          <div className="tab-page" hidden={side !== 'name'} data-tab="name">
            <NamePanel
              store={store}
              library={() => Object.values(projects.get().project?.compounds ?? {})}
              onOpenSettings={() => setShowLlm(true)}
            />
          </div>
          <div className="tab-page" hidden={side !== 'scheme' && side !== 'new-scheme'} data-tab="scheme">
            <SchemePanel onNewRun={newRun} store={store} newScheme={side === 'new-scheme'} onAi={hasKey ? openAi : undefined} />
          </div>
          <div className="tab-page" hidden={side !== 'run'} data-tab="run">
            {activeRun && <RunSummary store={store} runId={activeRun} />}
            {activeRun && dockClosed && (
              <button type="button" data-testid="run-dock-open" onClick={() => setDockClosed(false)}>下の表を開く</button>
            )}
          </div>
          <div className="tab-page" hidden={side !== 'table'} data-tab="table">
            <TablePanel store={store} onCreated={() => fitView()} />
          </div>
          <div className="tab-page" hidden={side !== 'analysis'} data-tab="analysis">
            <section className="card">
              <h2>SMILES</h2>
              <output data-testid="smiles" className={smiles.error ? 'error' : ''}>
                {smiles.error ?? (smiles.smiles || '（空）')}
              </output>
            </section>
            <AnalysisPanel store={store} showStereo={showStereo} setShowStereo={setShowStereo} setMarks={setNmrMarks} />
          </div>
          <div className="tab-page" hidden={side !== 'io'} data-tab="io">
            <IoPanel store={store} visibleRect={visibleRect} />
          </div>
        </div>
      </aside>
    </div>
  );
}

/** 色の候補（名前・値）。黒は色を外す */
const COLORS: [string, string | undefined][] = [
  ['黒', undefined],
  ['赤', '#d32f2f'],
  ['青', '#1e5bd8'],
  ['緑', '#2e7d32'],
  ['橙', '#e67700'],
  ['紫', '#7b1fa2'],
  ['灰', '#757575'],
];

/** 右の欄に出す物 */
export type SideView = 'home' | 'scheme' | 'new-scheme' | 'table' | 'analysis' | 'ai' | 'name' | 'io' | 'run';
export type AiMode = 'create' | 'edit' | 'write' | 'finish';

const SIDE_TITLE: Record<Exclude<SideView, 'ai'> | `ai-${AiMode}`, string> = {
  home: 'この文書',
  scheme: '反応スキーム',
  'new-scheme': '新しい反応スキーム',
  table: '検討表',
  run: '実験の記録',
  analysis: '分子',
  name: '名前から置く',
  io: '読み込みと書き出し',
  'ai-create': 'AI で作る',
  'ai-edit': 'AI で直す',
  'ai-write': '実験項を書く',
  'ai-finish': '投稿の形に整える',
};

/** キーの操作の一覧（ヘルプのメニューから開く） */
function Shortcuts({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="about shortcuts" data-testid="shortcuts" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <h2>キーの操作</h2>
      <dl>
        <dt>原子に合わせて C N O S F P / L(Cl) B(Br) I H / M(Me) E(Et)</dt>
        <dd>元素・略号を変える</dd>
        <dt>原子に合わせて + / -</dt>
        <dd>電荷</dd>
        <dt>原子に合わせて Enter・ダブルクリック</dt>
        <dd>NH2、OMe、Boc、N+ などのラベルを入れる</dd>
        <dt>結合に合わせて 1 2 3 / W H Y</dt>
        <dd>次数 / くさび・破線・波線</dd>
        <dt>何も指さずに V / 1 2 3 / W H / A / R / T</dt>
        <dd>道具を選ぶ。選択 / 単・二重・三重結合 / くさび（実線・破線） / ベンゼン / 反応矢印 / 文字</dd>
        <dt>Delete</dt>
        <dd>選んだ物を消す。何も選んでいなければカーソルの下を消す</dd>
        <dt>Ctrl+S / Ctrl+O</dt>
        <dd>文書を保存 / 開く</dd>
        <dt>ホイール / スペース＋ドラッグ</dt>
        <dd>表示を動かす。Ctrl＋ホイールで拡大・縮小</dd>
        <dt>Shift＋1</dt>
        <dd>図の全体を表示する</dd>
        <dt>Ctrl+Z / Ctrl+Y</dt>
        <dd>元に戻す / やり直す</dd>
        <dt>Ctrl+X C V A</dt>
        <dd>切り取り・コピー・貼り付け・すべて選択</dd>
        <dt>Ctrl+Shift+K</dt>
        <dd>Clean Structure</dd>
        <dt>Ctrl+Shift+H / V</dt>
        <dd>左右 / 上下の反転</dd>
      </dl>
      <form method="dialog">
        <button type="submit">閉じる</button>
      </form>
    </dialog>
  );
}
