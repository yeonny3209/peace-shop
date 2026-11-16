/* 검색 뉴스 RSS를 읽어 가족 회사에 맞는 소식만 규칙으로 분류한다. */
'use strict';

const feeds = [
  { category: 'weather', query: '한국 기상청 한파 한랭 예보 특보' },
  { category: 'weather', query: '한국 기상청 폭염 무더위 예보 특보' },
  { category: 'weather', query: '한국 태풍 호우 폭우 농작물 피해' },
  { category: 'season', query: '제철 과일 감귤 딸기 수확 작황' },
  { category: 'news', query: '코코아 카카오 가격 공급 작황' },
  { category: 'news', query: '밀가루 밀 가격 제빵 원가' },
  { category: 'news', query: '음료 주스 판매 수요 여름' },
  { category: 'news', query: '라면 분식 판매 수요 식품' },
  { category: 'news', query: '문구 종이 가격 수요' },
  { category: 'news', query: '보드게임 게임 판매 수요 신작' },
  { category: 'news', query: '과자 제과 판매 수요 식품' },
];

function decodeXml(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : parseInt(n, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'");
}
function tag(item, name) {
  const match = item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? decodeXml(match[1]).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}
function parseRss(xml, category, now = Date.now()) {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1];
    const title = tag(item, 'title').slice(0, 100);
    const link = tag(item, 'link');
    const sourceMatch = item.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i);
    const sourceName = sourceMatch ? decodeXml(sourceMatch[1]).replace(/<[^>]*>/g, '').trim().slice(0, 80) : 'Google 뉴스';
    const published = Date.parse(tag(item, 'pubDate'));
    if (!title || !/^https:\/\//i.test(link) || !Number.isFinite(published) || published > now + 60 * 60 * 1000 || now - published > 36 * 60 * 60 * 1000) return null;
    return { title, link, sourceName, publishedAt: new Date(published).toISOString(), category };
  }).filter(Boolean);
}

function impactFor(article) {
  const text = `${article.title} ${article.summary || ''}`;
  if (/(한파|한랭|기온\s*(?:급)?하강|강추위)/.test(text)) return { company: '한밤라면', delta: /경보|역대|강추위/.test(text) ? 2 : 1, reason: '추운 날에는 따뜻한 식사 수요가 늘 수 있다는 가족용 계절 규칙' };
  if (/(폭염|무더위|열대야|기온\s*급상승)/.test(text)) return { company: '상큼주스', delta: /경보|역대|폭염주의보/.test(text) ? 2 : 1, reason: '더운 날에는 시원한 음료 수요가 늘 수 있다는 가족용 계절 규칙' };
  if (/(태풍|호우|폭우|냉해|우박)/.test(text) && /(농작물|과수|농가|수확|과일|채소|작황)/.test(text)) return { company: '싱싱과일', delta: -2, reason: '기상 피해가 농작물 수확에 부담을 줄 수 있다는 기사 내용' };
  if (/(감귤|귤|딸기|사과|과일|채소)/.test(text) && /(풍년|풍작|작황\s*호조|수확량\s*증가|출하량\s*증가)/.test(text)) return { company: '싱싱과일', delta: 1, reason: '작황 또는 수확량 개선이 과일 회사에 유리할 수 있다는 기사 내용' };
  if (/(감귤|귤|딸기|사과|과일|채소)/.test(text) && /(흉작|작황\s*부진|수확량\s*감소|냉해|병충해)/.test(text)) return { company: '싱싱과일', delta: -1, reason: '작황 또는 수확량 악화가 과일 회사에 불리할 수 있다는 기사 내용' };
  if (/(코코아|카카오)/.test(text) && /(가격\s*(?:급)?상승|급등|공급난|수급\s*불안|흉작)/.test(text)) return { company: '달콤초콜릿', delta: -1, reason: '코코아 원료 조달 비용이 오르면 초콜릿 회사에 부담이 될 수 있다는 기사 내용' };
  if (/(코코아|카카오)/.test(text) && /(가격\s*하락|공급\s*회복|풍작|수급\s*개선)/.test(text)) return { company: '달콤초콜릿', delta: 1, reason: '코코아 원료 공급이 나아지면 초콜릿 회사에 유리할 수 있다는 기사 내용' };
  if (/(밀가루|밀\s*가격|제빵\s*원가)/.test(text) && /(가격\s*(?:급)?상승|급등|공급난|수급\s*불안)/.test(text)) return { company: '우리집베이커리', delta: -1, reason: '밀 원료 비용 상승이 빵 생산에 부담이 될 수 있다는 기사 내용' };
  if (/(밀가루|밀\s*가격|제빵\s*원가)/.test(text) && /(가격\s*하락|공급\s*회복|안정세)/.test(text)) return { company: '우리집베이커리', delta: 1, reason: '밀 원료 비용 완화가 빵 생산에 유리할 수 있다는 기사 내용' };
  if (/(종이|펄프|문구\s*원가)/.test(text) && /(가격\s*(?:급)?상승|급등|공급난)/.test(text)) return { company: '반짝문구', delta: -1, reason: '종이 원료 비용 상승이 문구 회사에 부담이 될 수 있다는 기사 내용' };
  if (/(종이|펄프|문구\s*원가)/.test(text) && /(가격\s*하락|공급\s*회복|안정세)/.test(text)) return { company: '반짝문구', delta: 1, reason: '종이 원료 비용 완화가 문구 회사에 유리할 수 있다는 기사 내용' };
  if (/(보드게임|게임)/.test(text) && /(판매\s*증가|매출\s*증가|인기|흥행|이용자\s*증가)/.test(text)) return { company: /보드게임/.test(text) ? '즐거운보드게임' : '피스게임즈', delta: 1, reason: '게임 판매·이용 수요 증가가 회사에 유리할 수 있다는 기사 내용' };
  if (/(보드게임|게임)/.test(text) && /(판매\s*감소|매출\s*감소|이용자\s*감소|서비스\s*종료)/.test(text)) return { company: /보드게임/.test(text) ? '즐거운보드게임' : '피스게임즈', delta: -1, reason: '게임 판매·이용 수요 감소가 회사에 불리할 수 있다는 기사 내용' };
  if (/(과자|제과)/.test(text) && /(판매\s*증가|매출\s*증가|수요\s*증가|인기)/.test(text)) return { company: '바삭과자', delta: 1, reason: '과자 판매 또는 수요 증가가 회사에 유리할 수 있다는 기사 내용' };
  if (/(과자|제과)/.test(text) && /(판매\s*감소|매출\s*감소|수요\s*감소)/.test(text)) return { company: '바삭과자', delta: -1, reason: '과자 판매 또는 수요 감소가 회사에 불리할 수 있다는 기사 내용' };
  return null;
}

module.exports = { feeds, parseRss, impactFor };
