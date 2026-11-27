// The imagegen skill's files, imported as text (Bun inlines them into the bundle).
declare module "*.md" {
  const text: string
  export default text
}
