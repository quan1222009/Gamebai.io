// --- 1. SETUP THƯ VIỆN & CÀI ĐẶT CƠ BẢN ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
// const { v4: uuidv4 } = require('uuid'); // Không dùng UUID nữa để tạo ID bằng số

// Thiết lập môi trường
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'; 

// Kết nối Redis
const redis = new Redis(REDIS_URL);

// Lưu trữ thông tin người dùng đang online
const userProfiles = new Map();
const activeUsers = new Set(); // Dùng Set để kiểm tra ID không trùng lặp

// --- Hàm tạo ID 12 chữ số ngẫu nhiên không trùng lặp ---
function generateNumericId(length = 12) {
    let id;
    do {
        id = '';
        for (let i = 0; i < length; i++) {
            id += Math.floor(Math.random() * 10);
        }
    } while (activeUsers.has(id)); // Lặp lại nếu ID đã tồn tại
    activeUsers.add(id);
    return id;
}


// #######################################################
// --- 2. LOGIC BÀI TÂY CƠ BẢN & ID USER ---
// #######################################################

// --- A. Định nghĩa Bài Tây (Không thay đổi) ---
const SUIT_ORDER = { 'C': 4, 'R': 3, 'T': 2, 'B': 1 }; 
const SUITS = ['C', 'R', 'T', 'B'];
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const RANK_VALUES = {
    '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 
    '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, '2': 15 
};

function createAndShuffleDeck() {
    let deck = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) {
            deck.push({ rank, suit, value: RANK_VALUES[rank], suit_value: SUIT_ORDER[suit] });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]]; 
    }
    return deck;
}


// --- B. Khung hàm kiểm tra luật ---
function isValidSet(cards, gameType) { /* ... (Logic kiểm tra) ... */ return true; }
function canBeat(newCards, oldCards, gameType) { /* ... (Logic kiểm tra ăn đè) ... */ return true; }


// #######################################################
// --- 3. LOGIC QUẢN LÝ GAME & GHÉP TRẬN ---
// #######################################################

const matchQueues = { 'sam': [], 'tienlen': [], 'lieng': [], 'bacay': [] };
const activeRooms = new Map();
const privateRoomCodes = new Map(); 
let nextRoomId = 1;

/**
 * Tạo và khởi tạo trạng thái game mới.
 */
function createNewGame(gameType, playerIds, isPrivate = false) {
    const cardsToDeal = (gameType === 'sam' || gameType === 'tienlen') ? 13 : 3;
    const deck = createAndShuffleDeck(); 
    const playerCards = {};
    
    let k = 0;
    for (const id of playerIds) {
        playerCards[id] = deck.slice(k, k + cardsToDeal);
        k += cardsToDeal;
        playerCards[id].sort((a, b) => {
            if (a.value !== b.value) return a.value - b.value;
            return a.suit_value - b.suit_value;
        });
    }

    const starterId = playerIds[Math.floor(Math.random() * playerIds.length)];
    
    const gameState = {
        id: `R_${nextRoomId++}`,
        type: gameType,
        players: playerIds,
        status: 'waiting_action', 
        cards: playerCards,
        currentPlayer: starterId, 
        lastPlayed: null,
        passCount: 0,
        samCalled: null, 
        mustPlay: false 
    };

    redis.set(`room:${gameState.id}`, JSON.stringify(gameState));
    return gameState;
}

/**
 * [BỔ SUNG] Logic Bot tự động đánh
 */
async function botMove(roomId, botId, roomState) {
    console.log(`[BOT] Đến lượt Bot ${botId}`);
    
    // Giả lập độ trễ khi Bot nghĩ
    await new Promise(resolve => setTimeout(resolve, 1500)); 
    
    // **LOGIC ĐÁNH BÀI CƠ BẢN**
    let playedCards = [];
    const botHand = roomState.cards[botId];

    if (!roomState.lastPlayed || roomState.passCount === roomState.players.length - 1) {
        // Lượt đầu tiên hoặc bàn mới: Đánh lá bài nhỏ nhất (3 Bích)
        playedCards = [botHand[0]]; 
    } else {
        // Cố gắng ăn bài: Tìm lá bài rác nhỏ nhất lớn hơn lá bài rác cuối cùng
        const lastCard = roomState.lastPlayed[0];
        const canBeatCard = botHand.find(card => 
            card.value > lastCard.value || 
            (card.value === lastCard.value && card.suit_value > lastCard.suit_value)
        );
        
        if (canBeatCard) {
            playedCards = [canBeatCard];
        } else {
            // Không ăn được: Bỏ lượt
            return io.to(roomId).emit('bot_action', { userId: botId, action: 'pass' });
        }
    }

    // Cập nhật trạng thái sau khi Bot đánh
    // (Logic xóa bài khỏi tay bot, cập nhật lastPlayed, chuyển lượt cần được viết chi tiết)
    
    io.to(roomId).emit('bot_action', { userId: botId, action: 'play', cards: playedCards });
    console.log(`[BOT] Bot ${botId} đánh:`, playedCards);
    
    // Gửi game_state_update sau khi Bot đánh xong
    // await redis.set(`room:${roomId}`, JSON.stringify(roomState));
    // io.to(roomId).emit('game_state_update', roomState);
}


// #######################################################
// --- 4. SOCKET.IO: KẾT NỐI, ID VÀ HÀNH ĐỘNG GAME ---
// #######################################################

io.on('connection', (socket) => {
    // --- Gán ID Người dùng 12 số ---
    const userId = generateNumericId(12);
    socket.data.userId = userId;
    socket.data.roomId = null;
    userProfiles.set(userId, { socketId: socket.id, username: `Guest_${userId.substring(0, 4)}`, friends: [] });
    
    socket.emit('my_user_id', userId); 
    console.log(`User connected: ${socket.id} (ID: ${userId})`);


    // --- [BỔ SUNG] Chơi với Bot ---
    socket.on('join_bot_game', (gameType) => {
        if (!matchQueues[gameType]) return socket.emit('error', 'Loại game không hợp lệ.');

        // Tạo phòng chơi 1 người + 3 Bot
        const botIds = ['Bot_A', 'Bot_B', 'Bot_C'];
        const players = [socket.data.userId, ...botIds];
        
        const newGame = createNewGame(gameType, players, true);
        activeRooms.set(newGame.id, newGame);
        
        socket.join(newGame.id);
        socket.data.roomId = newGame.id;

        socket.emit('match_found', { roomId: newGame.id, gameType, players: players });
        socket.emit('game_state_update', newGame); 
        
        console.log(`[BOT] Game ${newGame.id} with Bots started.`);
    });
    
    // --- Ghép trận Nhanh (Đã có logic trước) ---
    socket.on('join_queue', (gameType) => { /* ... */ });

    // --- Ghép trận Solo/Private (Đã có logic trước) ---
    socket.on('create_private_room', (gameType) => { /* ... */ });
    socket.on('join_private_room', (roomCode) => { /* ... */ });
    
    // --- [BỔ SUNG] Kết bạn bằng ID ---
    socket.on('add_friend_by_id', (targetId) => {
        // Tạm thời chỉ xử lý trên userProfiles (Map)
        const targetProfile = userProfiles.get(targetId);
        
        if (targetProfile) {
            // Logic thêm bạn bè
            const myProfile = userProfiles.get(socket.data.userId);
            if (!myProfile.friends.includes(targetId)) {
                myProfile.friends.push(targetId);
                // Cần thông báo cho người bạn kia
                
                socket.emit('friend_status', `Đã thêm ${targetId} vào danh sách bạn bè.`);
            } else {
                socket.emit('friend_status', `${targetId} đã là bạn bè.`);
            }
        } else {
            socket.emit('friend_status', `ID người chơi ${targetId} không tồn tại hoặc không online.`);
        }
    });


    // --- Hành động Đánh bài (Bổ sung xử lý BOT) ---
    socket.on('play_cards', async (data) => {
        // ... (Logic kiểm tra lượt và đánh bài) ...
        // [QUAN TRỌNG] Logic chuyển lượt cần được viết:
        // 1. Tìm người chơi tiếp theo (nextPlayerId)
        // 2. Nếu nextPlayerId là Bot (Bot_A, Bot_B, Bot_C), gọi botMove()
    });
    
    // --- Xử lý ngắt kết nối ---
    socket.on('disconnect', () => {
        activeUsers.delete(socket.data.userId); // Xóa ID khỏi Set
        userProfiles.delete(socket.data.userId);
        // ...
    });
});


// --- 5. EXPRESS ROUTING: PHỤC VỤ TRANG TĨNH ---
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});


// --- 6. KHỞI ĐỘNG SERVER ---
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Redis connected: ${REDIS_URL}`);
});
