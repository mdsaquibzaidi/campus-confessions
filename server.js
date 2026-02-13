const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_LENGTH = 280;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Database ──────────────────────────────────────────────

const db = new sqlite3.Database('./confessions.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to SQLite.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        mood TEXT DEFAULT 'none',
        image TEXT,
        likes INTEGER DEFAULT 0,
        reposts INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        reason TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id)
    )`);

    // Lightweight migrations for existing DBs
    db.all(`PRAGMA table_info(posts)`, [], (err, cols) => {
        if (err) return;
        const names = new Set((cols || []).map(c => c.name));
        if (!names.has('image')) {
            db.run(`ALTER TABLE posts ADD COLUMN image TEXT`, [], () => {});
        }
    });
});

// ── Helpers ───────────────────────────────────────────────

function getReactionsForPosts(ids, callback) {
    if (ids.length === 0) return callback({});
    const placeholders = ids.map(() => '?').join(',');
    db.all(
        `SELECT post_id, type, COUNT(*) as count FROM reactions WHERE post_id IN (${placeholders}) GROUP BY post_id, type`,
        ids,
        (err, rows) => {
            if (err) return callback({});
            const map = {};
            rows.forEach(r => {
                if (!map[r.post_id]) map[r.post_id] = {};
                map[r.post_id][r.type] = r.count;
            });
            callback(map);
        }
    );
}

// ── Routes ────────────────────────────────────────────────

// Get all posts
app.get('/api/posts', (req, res) => {
    const order = req.query.sort === 'top'
        ? '(COALESCE(r.reaction_count, 0) + posts.reposts + posts.likes) DESC'
        : 'posts.timestamp DESC';

    db.all(`
        SELECT posts.*,
            COALESCE(r.reaction_count, 0) as reaction_count,
            COALESCE(rep.reply_count, 0) as reply_count
        FROM posts
        LEFT JOIN (SELECT post_id, COUNT(*) as reaction_count FROM reactions GROUP BY post_id) r ON r.post_id = posts.id
        LEFT JOIN (SELECT post_id, COUNT(*) as reply_count FROM replies GROUP BY post_id) rep ON rep.post_id = posts.id
        ORDER BY ${order}
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        getReactionsForPosts(rows.map(r => r.id), (reactionsMap) => {
            res.json(rows.map(row => ({ ...row, reactions: reactionsMap[row.id] || {} })));
        });
    });
});

// Create post
app.post('/api/posts', (req, res) => {
    const { text, mood, image } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Post cannot be empty' });
    if (text.trim().length > MAX_LENGTH) return res.status(400).json({ error: `Max ${MAX_LENGTH} characters` });

    const validMoods = ['none', 'love', 'happy', 'sad', 'angry', 'anxious', 'excited'];
    const safeMood = validMoods.includes(mood) ? mood : 'none';

    db.run(`INSERT INTO posts (text, mood, image) VALUES (?, ?, ?)`, [text.trim(), safeMood, image || null], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, text: text.trim(), mood: safeMood, image: image || null, likes: 0, reposts: 0, reactions: {}, reply_count: 0 });
    });
});

// Edit a post
app.put('/api/posts/:id', (req, res) => {
    const { text, mood, image } = req.body;
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Post cannot be empty' });
    if (text.trim().length > MAX_LENGTH) return res.status(400).json({ error: `Max ${MAX_LENGTH} characters` });

    const validMoods = ['none', 'love', 'happy', 'sad', 'angry', 'anxious', 'excited'];
    const safeMood = validMoods.includes(mood) ? mood : 'none';

    db.run(
        `UPDATE posts SET text = ?, mood = ?, image = ? WHERE id = ?`,
        [text.trim(), safeMood, image || null, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
            res.json({ id: Number(req.params.id), text: text.trim(), mood: safeMood, image: image || null });
        }
    );
});

// Delete a post (also deletes its reactions, replies, reports)
app.delete('/api/posts/:id', (req, res) => {
    const id = req.params.id;
    db.serialize(() => {
        db.run(`DELETE FROM reactions WHERE post_id = ?`, [id]);
        db.run(`DELETE FROM replies WHERE post_id = ?`, [id]);
        db.run(`DELETE FROM reports WHERE post_id = ?`, [id]);
        db.run(`DELETE FROM posts WHERE id = ?`, [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
            res.json({ ok: true });
        });
    });
});

// Like a post
app.post('/api/posts/:id/like', (req, res) => {
    db.run(`UPDATE posts SET likes = likes + 1 WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
        db.get(`SELECT likes FROM posts WHERE id = ?`, [req.params.id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ likes: row.likes });
        });
    });
});

// Repost
app.post('/api/posts/:id/repost', (req, res) => {
    db.run(`UPDATE posts SET reposts = reposts + 1 WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
        db.get(`SELECT reposts FROM posts WHERE id = ?`, [req.params.id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ reposts: row.reposts });
        });
    });
});

// React to a post
app.post('/api/posts/:id/react', (req, res) => {
    const { type } = req.body;
    const validTypes = ['love', 'haha', 'sad', 'angry', 'fire'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid reaction' });

    db.run(`INSERT INTO reactions (post_id, type) VALUES (?, ?)`, [req.params.id, type], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.all(`SELECT type, COUNT(*) as count FROM reactions WHERE post_id = ? GROUP BY type`, [req.params.id], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const reactions = {};
            rows.forEach(r => reactions[r.type] = r.count);
            res.json({ reactions });
        });
    });
});

// Get replies
app.get('/api/posts/:id/replies', (req, res) => {
    db.all(`SELECT * FROM replies WHERE post_id = ? ORDER BY timestamp ASC`, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Post reply
app.post('/api/posts/:id/reply', (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Reply cannot be empty' });

    db.run(`INSERT INTO replies (post_id, text) VALUES (?, ?)`, [req.params.id, text.trim()], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, post_id: Number(req.params.id), text: text.trim() });
    });
});

// Report a post
app.post('/api/posts/:id/report', (req, res) => {
    const { reason } = req.body;
    const validReasons = ['spam', 'inappropriate', 'harassment', 'hate_speech', 'violence', 'copyright', 'other'];
    if (!validReasons.includes(reason)) return res.status(400).json({ error: 'Invalid reason' });

    db.run(`INSERT INTO reports (post_id, reason) VALUES (?, ?)`, [req.params.id, reason], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, post_id: Number(req.params.id), reason });
    });
});

// ── Start ─────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
