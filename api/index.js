// api/index.js
export default async function handler(req, res) {
  try {
    // リクエストの処理内容をここに記述
    res.status(200).json({ message: 'Hello from Vercel!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
