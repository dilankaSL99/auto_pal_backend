import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app, registerUser, auth, cleanupUsers, type TestUser } from './helpers';
import { prisma } from '../src/prisma';

let user: TestUser;
let documentId: string;

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  user = await registerUser();
  const doc = await request(app)
    .post('/api/documents')
    .set(auth(user.accessToken))
    .send({ title: 'Insurance', documentType: 'insurance' });
  documentId = doc.body.document.id;
});

afterAll(async () => {
  await cleanupUsers(user.phoneNumber);
  await prisma.$disconnect();
});

describe('file uploads', () => {
  it('accepts an allowed image type', async () => {
    const res = await request(app)
      .post(`/api/documents/${documentId}/file`)
      .set(auth(user.accessToken))
      .attach('file', PNG, { filename: 'scan.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.document.fileName).toBe('scan.png');
  });

  it('rejects a disallowed / active file type (e.g. .html)', async () => {
    const res = await request(app)
      .post(`/api/documents/${documentId}/file`)
      .set(auth(user.accessToken))
      .attach('file', Buffer.from('<script>alert(1)</script>'), {
        filename: 'evil.html',
        contentType: 'text/html',
      });
    expect(res.status).toBe(400);
  });

  it("does not let another user upload to your document", async () => {
    const other = await registerUser();
    try {
      const res = await request(app)
        .post(`/api/documents/${documentId}/file`)
        .set(auth(other.accessToken))
        .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' });
      expect(res.status).toBe(404);
    } finally {
      await cleanupUsers(other.phoneNumber);
    }
  });
});
