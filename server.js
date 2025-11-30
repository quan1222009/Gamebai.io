// --- 1. SETUP THƯ VIỆN & CÀI ĐẶT CƠ BẢN ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');

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
const activeUsers = new Set(); 

// --- Hàm tạo ID 12 chữ số ngẫu nhiên không trùng lặp (Giữ nguyên) ---
function generateNumericId(length = 12) {
    let id;
    do {
        id = '';
        for (let i = 0; i < length; i++) {
            id += Math.floor(Math.random() * 10);
        }
    } while (activeUsers.has(id)); 
    activeUsers.add(id);
    return id;
}


// #######################################################
// --- 2. LOGIC BÀI TÂY CƠ BẢN & ID USER ---
// #######################################################

// --- A. Định nghĩa Bài Tây ---
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


// --- B. KHUNG HÀM KIỂM TRA LUẬT CHO TẤT CẢ CÁC GAME ---

/**
 * Kiểm tra bộ bài có hợp lệ trong game hiện tại không.
 * @param {Array<Object>} cards Bộ bài người chơi muốn đánh
 * @param {string} gameType Loại game ('sam', 'tienlen', 'lieng', 'bacay')
 */
function isValidSet(cards, gameType) {
    if (cards.length === 0) return false;
    
    // Luật Sâm/Tiến Lên: Cần có 1, 2, 3... lá bài hợp thành bộ.
    if (gameType === 'sam' || gameType === 'tienlen') {
        const len = cards.length;
        // Tối thiểu kiểm tra bài rác, đôi, bộ ba
        if (len === 1 || len === 2 || len === 3) return true; 
        // Logic Sảnh/Tứ Quý/3-4 Đôi thông cần được viết chi tiết ở đây.
        if (len >= 4) return true; // Tạm thời chấp nhận nếu số lượng lớn hơn 4
        return false;
    }
    
    // Luật Liêng/3 Cây: Chỉ cần 3 lá
    if (gameType === 'lieng' || gameType === 'bacay') {
        if (cards.length !== 3) return false;
        // Logic kiểm tra Sáp, Liêng, Ảnh, Điểm cần được viết chi tiết ở đây.
        return true; 
    }
    
    return false;
}

/**
 * Kiểm tra bộ bài mới có ăn được bộ bài cũ không.
 * @param {Array<Object>} newCards Bộ bài mới
 * @param {Array<Object> | null} oldCards Bộ bài cũ (nếu có)
 * @param {string} gameType Loại game
 */
function canBeat(newCards, oldCards, gameType) {
    if (!oldCards || oldCards.length === 0) return true; // Lượt đầu tiên

    // Luật Sâm/Tiến Lên
    if (gameType === 'sam' || gameType === 'tienlen') {
        if (newCards.length !== oldCards.length) {
            // Trường hợp đặc biệt: Tứ quý chặt 2, 3-4 đôi thông chặt 2/tứ quý
            // Cần so sánh logic chặt đặc biệt ở đây.
            return false;
        }

        // Tạm thời: Chỉ so sánh giá trị lá bài lớn nhất nếu cùng số lượng
        const maxNew = newCards.reduce((max, card) => card.value > max.value ? card : max);
        const maxOld = oldCards.reduce((max, card) => card.value > max.value ? card : max);
        
        if (maxNew.value > maxOld.value) return true;
        if (maxNew.value === maxOld.value && maxNew.suit_value > maxOld.suit_value) return true;
        
        return false;
    }

    // Luật Liêng/3 Cây: KHÔNG CÓ luật ăn đè trong ván chơi, chỉ so bài cuối ván.
    return true; 
}


// #######################################################
// --- 3. LOGIC QUẢN LÝ GAME & GHÉP TRẬN (Giữ nguyên) ---
// #######################################################

const matchQueues = { 'sam': [], 'tienlen': [], 'lieng': [], 'bacay': [] };
const activeRooms = new Map();
const privateRoomCodes = new Map(); 
let nextRoomId = 1;

/**
 * Xác định số bài chia và số người chơi tối thiểu theo loại game.
 * @param {string} gameType 
 * @returns {{cardsToDeal: number, minPlayers: number}}
 */
function getGameSettings(gameType) {
    switch (gameType) {
        case 'sam':
        case 'tienlen':
            return { cardsToDeal: 13, minPlayers: 4 };
        case 'lieng':
        case 'bacay':
            return { cardsToDeal: 3, minPlayers: 2 }; // Liêng/3 Cây thường 2-6 người
        default:
            return { cardsToDeal: 13, minPlayers: 4 };
    }
}


function createNewGame(gameType, playerIds, isPrivate = false) {
    const settings = getGameSettings(gameType);
    const deck = createAndShuffleDeck(); 
    const playerCards = {};
    
    let k = 0;
    for (const id of playerIds) {
        playerCards[id] = deck.slice(k, k + settings.cardsToDeal);
        k += settings.cardsToDeal;
        playerCards[id].sort((a, b) => {
            if (a.value !== b.value) return a.value - b.value;
            return a.suit_value - b.suit_value;
        });
    }

    const starterId = playerIds[Math.floor(Math.random() * playerIds.length)];
    
    const gameState = {
        id: `R_${nextRoomId++}`,
        type: gameType, // LƯU LOẠI GAME
        players: playerIds,
        status: (gameType === 'sam') ? 'waiting_action' : 'playing', // Sâm có bước Báo Sâm
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


// #######################################################
// --- 4. SOCKET.IO: KẾT NỐI, ID VÀ HÀNH ĐỘNG GAME (Giữ nguyên) ---
// #######################################################

io.on('connection', (socket) => {
    // --- Gán ID Người dùng 12 số ---
    const userId = generateNumericId(12);
    socket.data.userId = userId;
    socket.data.roomId = null;
    userProfiles.set(userId, { socketId: socket.id, username: `Guest_${userId.substring(0, 4)}`, friends: [] });
    
    socket.emit('my_user_id', userId); 
    console.log(`User connected: ${socket.id} (ID: ${userId})`);


    // --- Chơi với Bot ---
    socket.on('join_bot_game', (gameType) => {
        if (!matchQueues[gameType]) return socket.emit('error', 'Loại game không hợp lệ.');

        const settings = getGameSettings(gameType);
        
        // Tạo phòng chơi 1 người + (minPlayers - 1) Bot
        const botIds = [];
        for (let i = 0; i < settings.minPlayers - 1; i++) {
            botIds.push(`Bot_${String.fromCharCode(65 + i)}`); // Bot_A, Bot_B, ...
        }
        
        const players = [socket.data.userId, ...botIds];
        
        const newGame = createNewGame(gameType, players, true);
        activeRooms.set(newGame.id, newGame);
        
        socket.join(newGame.id);
        socket.data.roomId = newGame.id;

        socket.emit('match_found', { roomId: newGame.id, gameType, players: players });
        io.to(newGame.id).emit('game_state_update', newGame); 
    });
    
    // --- Ghép trận Nhanh ---
    // Cần cập nhật logic checkAndStartMatch để dùng getGameSettings
    socket.on('join_queue', (gameType) => {
        if (matchQueues[gameType]) {
            // Xóa khỏi hàng đợi cũ (nếu có)
            Object.values(matchQueues).forEach(queue => {
                const index = queue.indexOf(socket.id);
                if (index > -1) queue.splice(index, 1);
            });
            
            matchQueues[gameType].push(socket.id);
            socket.emit('queue_update', `Đã vào hàng đợi ${gameType}. Đang chờ...`);
            
            // checkAndStartMatch(gameType); // Cần triển khai hàm này
        } else {
            socket.emit('error', 'Loại game không hợp lệ.');
        }
    });

    // --- Hành động Đánh bài (Kiểm tra luật gameType) ---
    socket.on('play_cards', async (data) => {
        const { roomId, cards } = data;
        const roomStateStr = await redis.get(`room:${roomId}`);
        if (!roomStateStr) return;
        let roomState = JSON.parse(roomStateStr);

        if (roomState.currentPlayer !== socket.data.userId) return socket.emit('error', 'Không phải lượt của bạn.');
        
        // KIỂM TRA LUẬT THEO gameType
        if (!isValidSet(cards, roomState.type) || !canBeat(cards, roomState.lastPlayed, roomState.type)) {
            return socket.emit('error', 'Bộ bài không hợp lệ hoặc không thể ăn được (Luật game: ' + roomState.type + ').');
        }

        // ... (Cập nhật trạng thái) ...

        await redis.set(`room:${roomId}`, JSON.stringify(roomState));
        io.to(roomId).emit('game_state_update', roomState);
    });

    // ... (Các sự kiện khác: create_private_room, join_private_room, pass, bao_sam, disconnect) ...
    socket.on('create_private_room', (gameType) => { /* ... */ });
    socket.on('join_private_room', (roomCode) => { /* ... */ });
    socket.on('add_friend_by_id', (targetId) => { /* ... */ });
    socket.on('pass', async (data) => { /* ... */ });
    socket.on('bao_sam', async (data) => { /* ... */ });
    
    socket.on('disconnect', () => {
        activeUsers.delete(socket.data.userId); 
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
