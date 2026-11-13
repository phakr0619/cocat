"""書き出した CDXML を、ChemDraw の代わりに次の2つで読み、構造が崩れていないか確かめる。

1. RDKit（Python 版）: Revvity（ChemDraw の開発元）の CDXML ライブラリで読む。
   分子は MolsFromCDXMLFile、反応は ReactionsFromCDXMLFile（<scheme>/<step> を使う）。
2. Indigo（EPAM）: 別の実装で読み、PNG に描く（見た目の確認用）。

使い方:
    python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt
    npx vitest run tests/io.test.ts      # out/ に見本の CDXML を書き出す
    .venv/bin/python tools/verify_cdxml.py [CDXML のファイル ...]

ファイルの横に <名前>.expected.smi があれば、読んだ SMILES と比べる（RDKit で正規化）。
「A || B」と書くと、どちらかに合えばよい（ラセミ体は、ソフトによって描いた立体か鏡像のどちらかで読む）。
"""

import glob
import os
import sys

from rdkit import Chem, RDLogger
from rdkit.Chem import rdChemReactions

RDLogger.DisableLog("rdApp.*")

try:
    from indigo import Indigo
    from indigo.renderer import IndigoRenderer
except ImportError:  # Indigo は無くてもよい
    Indigo = None


def canon(smi):
    m = Chem.MolFromSmiles(smi)
    return Chem.MolToSmiles(m) if m else None


def canon_set(smiles_list):
    return sorted(filter(None, (canon(s) for s in smiles_list)))


def canon_rxn(rxn_smiles):
    reac, _, prod = rxn_smiles.split(">")
    return (canon_set(reac.split(".")) if reac else [], canon_set(prod.split(".")) if prod else [])


def check(path):
    name = os.path.splitext(path)[0]
    expected = None
    if os.path.exists(name + ".expected.smi"):
        expected = open(name + ".expected.smi").read().strip()
    is_rxn = expected is not None and ">" in expected
    problems = []
    report = {"file": path}

    # 1. RDKit（ChemDraw のライブラリ）
    is_cdx = path.lower().endswith(".cdx")
    if is_cdx:
        # ChemDraw のバイナリ（.cdx）も、同じ ChemDraw のライブラリで読める
        params = Chem.CDXMLParserParams()
        params.format = Chem.CDXMLFormat.CDX
        mols = list(Chem.MolsFromCDXMLFile(path, params))
    else:
        mols = Chem.MolsFromCDXMLFile(path)
    mol_smiles = [Chem.MolToSmiles(m) for m in mols if m is not None]
    report["rdkit_mols"] = ".".join(mol_smiles)
    if not mols:
        problems.append("RDKit が分子を読めない")
    if is_rxn and is_cdx:
        # RDKit は CDX の反応を読まないので、分子だけを比べる
        want = canon_set(".".join(expected.splitlines()[0].replace(">>", ".").split(">")).split("."))
        if canon_set(".".join(mol_smiles).split(".")) != want:
            problems.append(f"RDKit の分子が違う: {report['rdkit_mols']}")
    elif is_rxn:
        rxns = rdChemReactions.ReactionsFromCDXMLFile(path)
        if not rxns:
            problems.append("RDKit が反応（scheme/step）を読めない")
        else:
            got = rdChemReactions.ReactionToSmiles(rxns[0])
            report["rdkit_rxn"] = got
            for line in expected.splitlines()[:1]:
                if canon_rxn(got) != canon_rxn(line):
                    problems.append(f"RDKit の反応が違う: {got} / 期待 {line}")
    elif expected is not None:
        if not any(canon_set(".".join(mol_smiles).split(".")) == canon_set(alt.split(".")) for alt in expected.split(" || ")):
            problems.append(f"RDKit の分子が違う: {report['rdkit_mols']} / 期待 {expected}")

    # 2. Indigo（文書の物から始まる CDX は、ChemDraw の書き方だが Indigo が読まないので、CDXML だけ）
    if Indigo is not None and not is_cdx:
        ind = Indigo()
        renderer = IndigoRenderer(ind)
        ind.setOption("render-output-format", "png")
        ind.setOption("render-background-color", "1,1,1")
        try:
            obj = ind.loadReactionFromFile(path) if is_rxn else ind.loadMoleculeFromFile(path)
            if is_rxn:
                reac = canon_set(m.canonicalSmiles() for m in obj.iterateReactants())
                prod = canon_set(m.canonicalSmiles() for m in obj.iterateProducts())
                report["indigo"] = ".".join(reac) + ">>" + ".".join(prod)
                if expected and (reac, prod) != canon_rxn(expected.splitlines()[0]):
                    problems.append(f"Indigo の反応が違う: {report['indigo']}")
            else:
                got = obj.canonicalSmiles()
                report["indigo"] = got
                if expected and not any(canon_set(got.split(".")) == canon_set(alt.split(".")) for alt in expected.split(" || ")):
                    problems.append(f"Indigo の分子が違う: {got}")
            renderer.renderToFile(obj, name + ".indigo.png")
        except Exception as e:  # noqa: BLE001
            problems.append(f"Indigo が読めない: {e}")

    report["ok"] = not problems
    report["problems"] = problems
    return report


def main():
    paths = sys.argv[1:] or sorted(glob.glob("out/*.cdxml") + glob.glob("out/*.cdx"))
    if not paths:
        print("CDXML がありません。先に npx vitest run tests/io.test.ts を実行してください")
        return 1
    failed = 0
    for p in paths:
        r = check(p)
        mark = "OK " if r["ok"] else "NG "
        print(f"{mark} {p}")
        for k in ("rdkit_mols", "rdkit_rxn", "indigo"):
            if k in r:
                print(f"      {k}: {r[k]}")
        for pr in r["problems"]:
            print(f"      !! {pr}")
        failed += 0 if r["ok"] else 1
    print(f"\n{len(paths) - failed}/{len(paths)} OK")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
