import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import initRDKitModule from '@rdkit/rdkit';
import wasmUrl from '@rdkit/rdkit/RDKit_minimal.wasm?url';
import { setRDKit } from './chem/rdkit';
import { startRelayDiscovery } from './llm/settings';
import { App } from './ui/App';
import './ui/app.css';

const root = createRoot(document.getElementById('root')!);
root.render(<p className="loading">RDKit を読み込んでいます…</p>);

// このサイトに AI の中継があるか、1 回だけ聞く（GET で、AI は呼ばない）
startRelayDiscovery();

initRDKitModule({ locateFile: () => wasmUrl })
  .then((m) => {
    setRDKit(m);
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  })
  .catch((e) => root.render(<p className="loading">RDKit を読み込めませんでした: {String(e)}</p>));
