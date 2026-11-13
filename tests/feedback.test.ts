import { describe, expect, it } from 'vitest';
import { feedbackLink } from '../src/feedback';

describe('感想の送り先', () => {
  it('URL の {version} を版に置き換える（フォームの版の欄に自動で入る）', () => {
    const url = 'https://docs.google.com/forms/d/e/XXXX/viewform?usp=pp_url&entry.123={version}';
    expect(feedbackLink(url, '0.1.0+abc1234')).toBe('https://docs.google.com/forms/d/e/XXXX/viewform?usp=pp_url&entry.123=0.1.0%2Babc1234');
  });

  it('https でない値（空・mailto・javascript:）はリンクにしない', () => {
    expect(feedbackLink('', '1')).toBe('');
    expect(feedbackLink('mailto:a@example.com', '1')).toBe('');
    expect(feedbackLink('javascript:alert(1)', '1')).toBe('');
  });
});
