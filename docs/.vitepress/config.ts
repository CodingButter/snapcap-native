import { defineConfig } from "vitepress";

export default defineConfig({
  title: "@snapcap/native",
  description: "Browser-free Snap client. Native Node bridge to web.snapchat.com.",
  base: "/snapcap-native/",
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/api/" },
      { text: "Internals", link: "/internals/architecture" },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Auth model", link: "/guide/auth" },
            { text: "Persistence", link: "/guide/persistence" },
          ],
        },
      ],
      "/api/": [
        {
          text: "API reference",
          items: [
            { text: "Overview", link: "/api/" },
            { text: "SnapcapClient", link: "/api/snapcap-client" },
            { text: "Conversation", link: "/api/conversation" },
            { text: "User", link: "/api/user" },
            { text: "Storage", link: "/api/storage" },
            { text: "Sandbox", link: "/api/sandbox" },
          ],
        },
      ],
      "/internals/": [
        {
          text: "How it works",
          items: [
            { text: "Architecture", link: "/internals/architecture" },
            { text: "Sandbox isolation model", link: "/internals/sandbox" },
            { text: "Persistence model", link: "/internals/persistence" },
            { text: "The kameleon trick", link: "/internals/kameleon" },
            { text: "Webpack runtime patch", link: "/internals/webpack-trick" },
            { text: "SSO bearer flow", link: "/internals/sso-flow" },
            { text: "Fidelius E2E", link: "/internals/fidelius" },
            { text: "Why this works (and what doesn't)", link: "/internals/why-it-works" },
          ],
        },
      ],
      "/": [
        {
          text: "Reference",
          items: [
            { text: "API overview", link: "/api/" },
            { text: "SnapcapClient", link: "/api/snapcap-client" },
            { text: "Conversation", link: "/api/conversation" },
            { text: "User", link: "/api/user" },
            { text: "Storage", link: "/api/storage" },
            { text: "Sandbox", link: "/api/sandbox" },
            { text: "Web API recon", link: "/web-api-recon" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/codingbutter/snapcap-native" },
    ],

    search: { provider: "local" },

    footer: {
      message: "Released under the MIT license.",
      copyright: "snapcap",
    },
  },
});
