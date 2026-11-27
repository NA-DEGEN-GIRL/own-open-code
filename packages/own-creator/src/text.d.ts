// Creator mode's guidance and skills, imported as text (Bun inlines them into the bundle).
declare module "*.md" {
  const text: string
  export default text
}

declare module "*.txt" {
  const text: string
  export default text
}
