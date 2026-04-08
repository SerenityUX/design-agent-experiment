/** Output shape of `createApp().snapshot()` from frame-framework (see web-framework/src/index.js). */
export type FrameProjectSnapshot = {
  schema: string
  data: Record<string, unknown>
  components: {
    name: string
    css: string
    previewBody: string
    renderError?: string
  }[]
  meta?: {
    generatedFrom: string
    generatedAt: string
  }
}
