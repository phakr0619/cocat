// 使い方の統計の受け口（/e）。中身は見ずに 204 を返すだけで、オリジン（S3）には届けない。
// 記録は CloudFront のアクセスログ（日時・パス・クエリ・国だけ。analytics.tf の record_fields）に残る。
function handler(event) {
  return {
    statusCode: 204,
    statusDescription: 'No Content',
    headers: { 'cache-control': { value: 'no-store' } },
  };
}
