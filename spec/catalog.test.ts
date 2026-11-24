import { describe, expect, test } from 'bun:test'
import { createTestServer, JSON_API } from './helpers/test-server.ts'

describe('the resource catalog', () => {
  test('describes attributes, relationships and access well enough to write a document', async () => {
    const { app } = await createTestServer({ auth: false })
    const document = await (await app.request('/', { headers: { accept: JSON_API } })).json() as
      { meta: { resources: { type: string, description: any }[] } }
    const article = document.meta.resources.find(x => x.type === 'article')!.description
    expect(article.summary).toBe('A blog article')
    expect(article.access).toEqual({ read: 'session', create: 'session', signed: [] })
    expect(article.attributes.heading).toEqual(
      { type: 'string', required: false, readOnly: false, description: 'Heading', minLength: 2, maxLength: 100 })
    expect(article.attributes.owner.readOnly).toBe(true)
    expect(article.attributes.updated_at.readOnly).toBe(true)
    expect(article.attributes.visibility.readOnly).toBe(false)
    expect(article.relationships.tag).toEqual({ type: 'tag', cardinality: 'many' })
  })

  test('never describes hidden columns or resources', async () => {
    const { app } = await createTestServer({ auth: false })
    const text = await (await app.request('/', { headers: { accept: JSON_API } })).text()
    expect(text).not.toContain('"key"')
    expect(text).not.toContain('oidc_subject')
    expect(text).not.toContain('disabled_at')
  })
})
