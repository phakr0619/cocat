// 手元で OPSIN を動かす（server/opsin を mvn package で作った jar）。テストと評価で、Lambda の代わりに使う
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseOpsinAnswers, type OpsinClient } from '../src/chem/opsin';

export const OPSIN_JAR = 'server/opsin/target/opsin-lambda.jar';
export const hasOpsinJar = () => existsSync(OPSIN_JAR);

/** jar の main（標準入力の名前を 1 行に 1 つ → JSON）を呼ぶ */
export const javaOpsin: OpsinClient = async (names) => {
  const out = execFileSync('java', ['-jar', OPSIN_JAR], { input: names.join('\n'), stdio: ['pipe', 'pipe', 'ignore'] }).toString();
  return parseOpsinAnswers(JSON.parse(out), names.length);
};
