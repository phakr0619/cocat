// 名前 → 構造の手元の辞書
//
// よく使う溶媒・試薬・簡単な化合物だけ。名前と構造の対応は事実なので、手で書いた（外のデータは使っていない）。
// 送らずにすむ名前を増やすためのもので、ここに無い名前は LLM（src/llm/nameToStructure.ts）に回す

/** [SMILES, 名前…]。名前は大文字・小文字を区別しない */
const ENTRIES: [string, ...string[]][] = [
  ['O', 'water', '水'],
  ['CO', 'methanol', 'MeOH', 'メタノール'],
  ['CCO', 'ethanol', 'EtOH', 'エタノール'],
  ['CC(C)O', 'isopropanol', '2-propanol', 'isopropyl alcohol', 'IPA', '2-プロパノール'],
  ['CC(C)=O', 'acetone', 'propan-2-one', 'アセトン'],
  ['CC#N', 'acetonitrile', 'MeCN', 'アセトニトリル'],
  ['ClCCl', 'dichloromethane', 'methylene chloride', 'DCM', 'CH2Cl2', 'ジクロロメタン'],
  ['ClC(Cl)Cl', 'chloroform', 'trichloromethane', 'CHCl3', 'クロロホルム'],
  ['C1CCOC1', 'tetrahydrofuran', 'THF', 'oxolane', 'テトラヒドロフラン'],
  ['CCOCC', 'diethyl ether', 'ether', 'Et2O', 'ジエチルエーテル'],
  ['C1COCCO1', '1,4-dioxane', 'dioxane', '1,4-ジオキサン'],
  ['CCOC(C)=O', 'ethyl acetate', 'EtOAc', 'AcOEt', '酢酸エチル'],
  ['CC(=O)O', 'acetic acid', 'AcOH', '酢酸'],
  ['CC(=O)OC(C)=O', 'acetic anhydride', 'Ac2O', '無水酢酸'],
  ['CN(C)C=O', 'N,N-dimethylformamide', 'dimethylformamide', 'DMF'],
  ['CS(C)=O', 'dimethyl sulfoxide', 'DMSO', 'ジメチルスルホキシド'],
  ['CN1CCCC1=O', 'N-methyl-2-pyrrolidone', 'NMP'],
  ['CCCCCC', 'hexane', 'n-hexane', 'ヘキサン'],
  ['C1CCCCC1', 'cyclohexane', 'シクロヘキサン'],
  ['c1ccccc1', 'benzene', 'ベンゼン'],
  ['Cc1ccccc1', 'toluene', 'トルエン'],
  ['C=Cc1ccccc1', 'styrene', 'スチレン'],
  ['c1ccc2ccccc2c1', 'naphthalene', 'ナフタレン'],
  ['Oc1ccccc1', 'phenol', 'フェノール'],
  ['COc1ccccc1', 'anisole', 'methoxybenzene', 'アニソール'],
  ['Nc1ccccc1', 'aniline', 'アニリン'],
  ['OCc1ccccc1', 'benzyl alcohol', 'ベンジルアルコール'],
  ['O=Cc1ccccc1', 'benzaldehyde', 'ベンズアルデヒド'],
  ['OC(=O)c1ccccc1', 'benzoic acid', '安息香酸'],
  ['CC(=O)c1ccccc1', 'acetophenone', 'アセトフェノン'],
  ['O=[N+]([O-])c1ccccc1', 'nitrobenzene', 'ニトロベンゼン'],
  ['c1ccncc1', 'pyridine', 'ピリジン'],
  ['c1cc[nH]c1', 'pyrrole', 'ピロール'],
  ['c1ccoc1', 'furan', 'フラン'],
  ['c1ccsc1', 'thiophene', 'チオフェン'],
  ['c1c[nH]cn1', 'imidazole', 'イミダゾール'],
  ['c1ccc2[nH]ccc2c1', 'indole', 'インドール'],
  ['C1CCNCC1', 'piperidine', 'ピペリジン'],
  ['C1COCCN1', 'morpholine', 'モルホリン'],
  ['CCN(CC)CC', 'triethylamine', 'Et3N', 'TEA', 'トリエチルアミン'],
  ['CCN(C(C)C)C(C)C', 'N,N-diisopropylethylamine', 'diisopropylethylamine', 'DIPEA', 'DIEA', "Hünig's base"],
  ['CN(C)c1ccncc1', '4-dimethylaminopyridine', '4-(dimethylamino)pyridine', 'DMAP'],
  ['OC(=O)C(F)(F)F', 'trifluoroacetic acid', 'TFA', 'トリフルオロ酢酸'],
  ['CC(C)(C)OC(=O)OC(=O)OC(C)(C)C', 'di-tert-butyl dicarbonate', 'Boc2O', 'Boc anhydride', '二炭酸ジ-tert-ブチル'],
  ['c1ccc(P(c2ccccc2)c2ccccc2)cc1', 'triphenylphosphine', 'PPh3', 'トリフェニルホスフィン'],
  ['NCC(=O)O', 'glycine', 'Gly', 'グリシン'],
  ['C[C@H](N)C(=O)O', 'L-alanine', '(S)-alanine', 'L-Ala', 'L-アラニン'],
  ['CC(=O)Oc1ccccc1C(=O)O', 'aspirin', 'acetylsalicylic acid', 'アスピリン', 'アセチルサリチル酸'],
  ['Cn1cnc2c1c(=O)n(C)c(=O)n2C', 'caffeine', 'カフェイン'],
];

/** 比べるための形: 前後の空白を取り、空白を1つにし、ハイフン・ダッシュの類をそろえ、小文字にする */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/[’′]/g, "'")
    .toLowerCase();
}

const INDEX = new Map<string, string>();
for (const [smiles, ...names] of ENTRIES) for (const n of names) INDEX.set(normalizeName(n), smiles);

/** 辞書の名前から SMILES を引く。無ければ null */
export function lookupCommonName(name: string): string | null {
  return INDEX.get(normalizeName(name)) ?? null;
}

/** 辞書の全部（テスト用） */
export function commonNameEntries(): readonly [string, ...string[]][] {
  return ENTRIES;
}
