require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serve index.html

// MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=>console.log("MongoDB connected"))
  .catch(err=>console.error(err));

// Schemas
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  passwordHash: String,
  friends: [String]
});
const roomSchema = new mongoose.Schema({
  roomID: String,
  gameType: String,
  players: [{ userID: String, hand: Array, ready: Boolean }],
  currentTurn: Number,
  pile: Array,
  status: String
});

const User = mongoose.model('User', userSchema);
const Room = mongoose.model('Room', roomSchema);

// Auth routes
app.post('/api/register', async (req,res)=>{
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  try {
    const user = await User.create({ username, passwordHash: hash, friends: [] });
    res.json({ success:true, userID: user._id });
  } catch(e) { res.status(400).json({ error:"Username exists" }); }
});

app.post('/api/login', async (req,res)=>{
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if(!user) return res.status(400).json({ error:"User not found" });
  const match = await bcrypt.compare(password, user.passwordHash);
  if(!match) return res.status(400).json({ error:"Wrong password" });
  const token = jwt.sign({ userID:user._id }, process.env.JWT_SECRET, { expiresIn:"7d" });
  res.json({ success:true, token, userID:user._id });
});

// Create room
app.post('/api/room/create', async (req,res)=>{
  const { gameType, userID } = req.body;
  const roomID = Math.random().toString(36).substring(2,8);
  const room = await Room.create({ roomID, gameType, players:[{userID, hand:[], ready:true}], currentTurn:0, pile:[], status:"waiting" });
  res.json(room);
});

// Join room
app.post('/api/room/join', async (req,res)=>{
  const { roomID, userID } = req.body;
  const room = await Room.findOne({ roomID });
  if(!room) return res.status(404).json({ error:"Room not found" });
  room.players.push({ userID, hand:[], ready:false });
  await room.save();
  res.json(room);
});

// WebSocket
io.on('connection', socket=>{
  console.log("Socket connected:", socket.id);

  socket.on('joinRoom', roomID => { socket.join(roomID); });

  socket.on('playCard', ({roomID, userID, card})=>{
    io.to(roomID).emit('cardPlayed', { userID, card });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log("Server running on port", PORT));
