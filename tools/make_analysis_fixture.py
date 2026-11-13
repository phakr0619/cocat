"""tests/structures.ts の構造について、RDKit（Python 版）で分析の値を計算し、
tests/fixtures/analysis.json に書く（分析パネルの値のテストの正解）。

    .venv/bin/python tools/make_analysis_fixture.py
"""

import json
import re

from rdkit import Chem
from rdkit.Chem import Crippen, Descriptors, rdMolDescriptors

src = open("tests/structures.ts", encoding="utf-8").read()
pairs = re.findall(r"^\s*(\w+):\s*\n?\s*'([^']+)'", src, flags=re.M)
out = {}
for name, smi in pairs:
    smi = smi.replace("\\\\", "\\")
    m = Chem.MolFromSmiles(smi)
    Chem.AssignStereochemistry(m, cleanIt=True, force=True)
    labels = sorted(lab for _, lab in Chem.FindMolChiralCenters(m, includeUnassigned=True, useLegacyImplementation=True))
    out[name] = {
        "smiles": smi,
        "formula": re.sub(r"[+-]+$", "", rdMolDescriptors.CalcMolFormula(m)),
        "mw": Descriptors.MolWt(m),
        "exactMass": Descriptors.ExactMolWt(m),
        "logP": Crippen.MolLogP(m),
        "tpsa": rdMolDescriptors.CalcTPSA(m),
        "hbd": rdMolDescriptors.CalcNumHBD(m),
        "hba": rdMolDescriptors.CalcNumHBA(m),
        "stereo": labels,
    }
with open("tests/fixtures/analysis.json", "w", encoding="utf-8") as f:
    json.dump(out, f, indent=1, ensure_ascii=False)
    f.write("\n")
print(len(out), "structures")
