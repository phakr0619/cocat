import initRDKitModule from '@rdkit/rdkit';
import { hasRDKit, setRDKit } from '../src/chem/rdkit';

export async function loadRDKit() {
  if (!hasRDKit()) setRDKit(await initRDKitModule());
}
