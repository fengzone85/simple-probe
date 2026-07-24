import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.222.blue',
  integrations: [
    starlight({
      title: 'Simple Probe',
      description: '轻量自托管服务器监控',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/fengzone85/diting' },
      ],
      sidebar: [
        {
          label: '开始',
          items: ['intro', 'quick-start', 'install'],
        },
        {
          label: '指南',
          items: ['server', 'agent', 'native', 'windows'],
        },
        {
          label: '安全',
          items: ['security', 'threat-model', 'totp'],
        },
        {
          label: '参考',
          items: ['api', 'env', 'comparison', 'faq'],
        },
      ],
      customCss: ['./src/styles/custom.css'],
    }),
  ],
});
