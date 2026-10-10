// 品牌信息单一来源：文案与配色 token 都以此为准，改名字只需动这里
export const BRAND = {
  /** 全站统一署名，用于标题、导航、页脚、分享卡片 */
  name: '迅源 SwiftOrigin',
  /** 中文简称，用于窄屏与图标旁的短标签 */
  short: '迅源',
  /** 拉丁字标，用于 logo 副行 */
  wordmark: 'SWIFTORIGIN',
  /** 一句话主张 */
  tagline: '加速一切开发资源的取用路径',
  /** 默认 description：站点级，页面可用自己的 description 覆盖 */
  description:
    'GitHub、Docker 镜像、npm、Go、jsDelivr、unpkg、Maven、PyPI 的边缘加速代理，粘贴链接即可生成加速地址。',
} as const;

/** 地址栏 / 状态栏配色，与 global.css 的 --glass-page 保持一致 */
export const THEME_COLOR = {
  light: '#e3f2f8',
  dark: '#060d14',
} as const;
