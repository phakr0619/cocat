// 置ける雛形（テンプレート）: アミノ酸・糖・核酸塩基・よく使う環の骨格。構造は SMILES で持ち、使うときに RDKit で座標を作る。
// 立体は tests/templates.test.ts で CIP（R/S）を確かめている
export interface Template {
  /** 一覧に出す名前 */
  name: string;
  smiles: string;
  /** 一覧の名前に足す説明（「L 体」など） */
  note?: string;
}

export interface TemplateGroup {
  name: string;
  items: Template[];
}

export const TEMPLATE_GROUPS: TemplateGroup[] = [
  {
    name: '芳香環',
    items: [
      { name: 'ベンゼン', smiles: 'c1ccccc1' },
      { name: 'ナフタレン', smiles: 'c1ccc2ccccc2c1' },
      { name: 'アントラセン', smiles: 'c1ccc2cc3ccccc3cc2c1' },
      { name: 'ビフェニル', smiles: 'c1ccc(-c2ccccc2)cc1' },
      { name: 'ピリジン', smiles: 'c1ccncc1' },
      { name: 'ピリミジン', smiles: 'c1cncnc1' },
      { name: 'ピロール', smiles: 'c1cc[nH]c1' },
      { name: 'フラン', smiles: 'c1ccoc1' },
      { name: 'チオフェン', smiles: 'c1ccsc1' },
      { name: 'イミダゾール', smiles: 'c1c[nH]cn1' },
      { name: 'オキサゾール', smiles: 'c1cocn1' },
      { name: 'チアゾール', smiles: 'c1cscn1' },
      { name: 'インドール', smiles: 'c1ccc2[nH]ccc2c1' },
      { name: 'キノリン', smiles: 'c1ccc2ncccc2c1' },
      { name: 'イソキノリン', smiles: 'c1ccc2cnccc2c1' },
      { name: 'ベンゾフラン', smiles: 'c1ccc2occc2c1' },
      { name: 'プリン', smiles: 'c1ncc2[nH]cnc2n1' },
    ],
  },
  {
    name: 'アミノ酸',
    items: [
      { name: 'Gly', smiles: 'NCC(=O)O', note: 'グリシン' },
      { name: 'Ala', smiles: 'N[C@@H](C)C(=O)O', note: 'L-アラニン' },
      { name: 'Val', smiles: 'N[C@@H](C(C)C)C(=O)O', note: 'L-バリン' },
      { name: 'Leu', smiles: 'N[C@@H](CC(C)C)C(=O)O', note: 'L-ロイシン' },
      { name: 'Ile', smiles: 'N[C@@H]([C@@H](C)CC)C(=O)O', note: 'L-イソロイシン' },
      { name: 'Pro', smiles: 'OC(=O)[C@@H]1CCCN1', note: 'L-プロリン' },
      { name: 'Phe', smiles: 'N[C@@H](Cc1ccccc1)C(=O)O', note: 'L-フェニルアラニン' },
      { name: 'Trp', smiles: 'N[C@@H](Cc1c[nH]c2ccccc12)C(=O)O', note: 'L-トリプトファン' },
      { name: 'Met', smiles: 'N[C@@H](CCSC)C(=O)O', note: 'L-メチオニン' },
      { name: 'Ser', smiles: 'N[C@@H](CO)C(=O)O', note: 'L-セリン' },
      { name: 'Thr', smiles: 'N[C@@H]([C@@H](C)O)C(=O)O', note: 'L-トレオニン' },
      { name: 'Cys', smiles: 'N[C@@H](CS)C(=O)O', note: 'L-システイン' },
      { name: 'Tyr', smiles: 'N[C@@H](Cc1ccc(O)cc1)C(=O)O', note: 'L-チロシン' },
      { name: 'Asn', smiles: 'N[C@@H](CC(N)=O)C(=O)O', note: 'L-アスパラギン' },
      { name: 'Gln', smiles: 'N[C@@H](CCC(N)=O)C(=O)O', note: 'L-グルタミン' },
      { name: 'Asp', smiles: 'N[C@@H](CC(=O)O)C(=O)O', note: 'L-アスパラギン酸' },
      { name: 'Glu', smiles: 'N[C@@H](CCC(=O)O)C(=O)O', note: 'L-グルタミン酸' },
      { name: 'Lys', smiles: 'N[C@@H](CCCCN)C(=O)O', note: 'L-リシン' },
      { name: 'Arg', smiles: 'N[C@@H](CCCNC(N)=N)C(=O)O', note: 'L-アルギニン' },
      { name: 'His', smiles: 'N[C@@H](Cc1c[nH]cn1)C(=O)O', note: 'L-ヒスチジン' },
    ],
  },
  {
    name: '糖',
    items: [
      { name: 'β-Glc', smiles: 'OC[C@H]1O[C@@H](O)[C@H](O)[C@@H](O)[C@@H]1O', note: 'β-D-グルコピラノース' },
      { name: 'α-Glc', smiles: 'OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O', note: 'α-D-グルコピラノース' },
      { name: 'β-Gal', smiles: 'OC[C@H]1O[C@@H](O)[C@H](O)[C@@H](O)[C@H]1O', note: 'β-D-ガラクトピラノース' },
      { name: 'α-Man', smiles: 'OC[C@H]1O[C@H](O)[C@@H](O)[C@@H](O)[C@@H]1O', note: 'α-D-マンノピラノース' },
      { name: 'β-Rib', smiles: 'OC[C@H]1O[C@@H](O)[C@H](O)[C@@H]1O', note: 'β-D-リボフラノース' },
      { name: 'dRib', smiles: 'OC[C@H]1O[C@@H](O)C[C@@H]1O', note: '2-デオキシ-β-D-リボフラノース' },
    ],
  },
  {
    name: '核酸塩基',
    items: [
      { name: 'A', smiles: 'Nc1ncnc2[nH]cnc12', note: 'アデニン' },
      { name: 'G', smiles: 'Nc1nc2[nH]cnc2c(=O)[nH]1', note: 'グアニン' },
      { name: 'C', smiles: 'Nc1cc[nH]c(=O)n1', note: 'シトシン' },
      { name: 'T', smiles: 'Cc1c[nH]c(=O)[nH]c1=O', note: 'チミン' },
      { name: 'U', smiles: 'O=c1cc[nH]c(=O)[nH]1', note: 'ウラシル' },
    ],
  },
  {
    name: '骨格',
    items: [
      { name: 'ステロイド', smiles: 'C1CCC2C(C1)CCC1C2CCC2CCCC12', note: 'ステロイドの 4 環' },
      { name: 'ピペリジン', smiles: 'C1CCNCC1' },
      { name: 'ピペラジン', smiles: 'C1CNCCN1' },
      { name: 'モルホリン', smiles: 'C1COCCN1' },
      { name: 'テトラヒドロフラン', smiles: 'C1CCOC1' },
      { name: 'シクロペンタジエン', smiles: 'C1=CCC=C1' },
    ],
  },
];
