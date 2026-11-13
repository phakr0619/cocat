import { describe, expect, it } from 'vitest';
import { loadOrder, moveGroup, TOOL_GROUPS } from '../src/ui/Toolbar';

const names = TOOL_GROUPS.map((g) => g.name);

describe('左の道具のグループの並び', () => {
  it('はじめは 選択・結合・環・反応・図形・機構', () => {
    expect(names).toEqual(['選択', '結合', '環', '反応', '図形', '機構']);
    expect(loadOrder(names, null)).toEqual(names);
  });
  it('覚えた並びを使い、知らない名前は捨て、足りない名前は元の並びの所に足す', () => {
    expect(loadOrder(names, JSON.stringify(['機構', '選択', '結合', '環', '反応', '図形']))).toEqual(['機構', '選択', '結合', '環', '反応', '図形']);
    // 結合・環は元の並びで前にある「選択」の後ろ、図形・機構は「反応」の後ろに入る
    expect(loadOrder(names, JSON.stringify(['反応', '昔のグループ', '選択']))).toEqual(['反応', '図形', '機構', '選択', '結合', '環']);
    expect(loadOrder(names, 'こわれた')).toEqual(names);
  });
  it('動かす: 下から上へは前、上から下へは後ろ', () => {
    expect(moveGroup(names, '機構', '結合')).toEqual(['選択', '機構', '結合', '環', '反応', '図形']);
    expect(moveGroup(names, '選択', '環')).toEqual(['結合', '環', '選択', '反応', '図形', '機構']);
    expect(moveGroup(names, '環', '環')).toEqual(names);
  });
});
