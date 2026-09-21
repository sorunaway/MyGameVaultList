/*
 * 云服务接入配置
 *
 * 这几个值来自 WorkBuddy 云服务开通时返回的 publicConfig，
 * 是**唯一**允许出现在前端代码里的云服务标识。
 *
 * 安全性说明：
 *   · publishableKey 只用来标识「是哪个应用」，本身不含任何权限。
 *   · 服务端会强制校验来源域名，别的网站拿这个 key 也用不了。
 *   · 真正有权限的钥匙（数据库管理凭证、Steam API Key）全在服务端，
 *     永远不会下发到这里。
 */

window.CLOUD_CONFIG = {
  endpoint: 'https://my-game-vault.app.workbuddy.host',
  publishableKey: 'wbpk_7updyfojLndklpap00K3rt_0wUOLPWw2S3Be0161fcc0VKcwdsOVkeC',
  appId: 'wbapp_7updyfojLndklpap00K3rt'
};
