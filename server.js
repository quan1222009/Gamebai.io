// --- 1. SETUP THƯ VIỆN & CÀI ĐẶT CƠ BẢN ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid'); // Đã thêm uuid

// Thiết lập môi trường
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'; 

// Kết nối Redis
const redis = new Redis(REDIS_URL);

// Lưu trữ thông tin người dùng đang online (Tạm thời)
const userProfiles = new Map();


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

/**
 * Tạo bộ bài 52 lá không trùng nhau và xáo trộn ngẫu nhiên.
 */
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


// --- B. Hàm kiểm tra luật (Khung hàm, cần phát triển chi tiết) ---

/**
 * [Cần phát triển chi tiết] Kiểm tra bộ bài có hợp lệ (đôi, sảnh, rác, v.v.)
 */
function isValidSet(cards, gameType) {
    if (cards.length === 0) return false;
    // ... (Thêm logic kiểm tra sảnh, đôi, ba, v.v. cho Sâm/Tiến Lên)
    return true; 
}

/**
 * [Cần phát triển chi tiết] Kiểm tra bộ bài mới có ăn được bộ bài cũ không (Bao gồm luật CẤM ĂN ĐÈ 2)
 */
function canBeat(newCards, oldCards, gameType) {
    if (!oldCards || oldCards.length === 0) return true; // Lượt đầu tiên
    
    // Quy tắc CẤM ĂN ĐÈ 2 (Cho Sâm/Tiến Lên)
    if (oldCards.some(c => c.rank === '2') && newCards.some(c => c.rank === '2')) {
        // Nếu cả cũ và mới đều có 2, cần kiểm tra chặt 3 đôi thông/tứ quý
        return false; // Tạm thời cấm ăn đè 2 nếu không phải chặt đặc biệt
    }
    
    // ... (Logic kiểm tra giá trị và số lượng bài)
    return true; 
}


// #######################################################
// --- 3. LOGIC QUẢN LÝ GAME & GHÉP TRẬN ---
// #######################################################

const matchQueues = { 'sam': [], 'tienlen': [], 'lieng': [], 'bacay': [] };
const activeRooms = new Map();
const privateRoomCodes = new Map(); // Lưu trữ mã phòng riêng tư -> roomId
let nextRoomId = 1;

/**
 * Tạo và khởi tạo trạng thái game mới.
 */
function createNewGame(gameType, players, isPrivate = false) {
    const cardsToDeal = (gameType === 'sam' || gameType === 'tienlen') ? 13 : 3;
    const deck = createAndShuffleDeck(); 
    const playerCards = {};
    
    let k = 0;
    for (const player of players) {
        playerCards[player] = deck.slice(k, k + cardsToDeal);
        k += cardsToDeal;
        playerCards[player].sort((a, b) => {
            if (a.value !== b.value) return a.value - b.value;
            return a.suit_value - b.suit_value;
        });
    }

    // Chọn ngẫu nhiên 1 người đi trước (theo yêu cầu)
    const starterId = players[Math.floor(Math.random() * players.length)];
    
    const gameState = {
        id: `R_${nextRoomId++}`,
        type: gameType,
        players: players,
        status: 'waiting_action', // Trạng thái chờ Báo Sâm
        cards: playerCards,
        currentPlayer: starterId, 
        lastPlayed: null,
        passCount: 0,
        samCalled: null, // ID người báo Sâm
        mustPlay: false // Trong Sâm: Bắt buộc đi bài sau khi 3/3 bỏ lượt
    };

    redis.set(`room:${gameState.id}`, JSON.stringify(gameState));
    return gameState;
}


/**
 * Kiểm tra và bắt đầu trận đấu nếu đủ người.
 */
function checkAndStartMatch(gameType) {
    const queue = matchQueues[gameType];
    const MIN_PLAYERS = (gameType === 'sam' || gameType === 'tienlen') ? 4 : 4; 

    if (queue.length >= MIN_PLAYERS) {
        const players = queue.splice(0, MIN_PLAYERS);
        // Lấy UserID từ socket.data.userId
        const playerIds = players.map(socketId => io.sockets.sockets.get(socketId)?.data.userId || socketId);
        
        const newGame = createNewGame(gameType, playerIds); 
        activeRooms.set(newGame.id, newGame);

        // Gửi thông báo đến người chơi
        players.forEach(socketId => {
            const playerSocket = io.sockets.sockets.get(socketId);
            if (playerSocket) {
                playerSocket.join(newGame.id); 
                playerSocket.emit('match_found', { roomId: newGame.id, gameType, players: playerIds });
                playerSocket.emit('game_state_update', newGame); 
            }
        });

        console.log(`[MATCH] Game ${newGame.id} started for ${gameType}.`);
    }
}


// #######################################################
// --- 4. SOCKET.IO: KẾT NỐI, ID VÀ HÀNH ĐỘNG GAME ---
// #######################################################

io.on('connection', (socket) => {
    // --- Gán ID Người dùng (Cho chức năng Kết bạn) ---
    const fullUuid = uuidv4();
    const userId = fullUuid.substring(0, 8); // Cấp ID ngẫu nhiên, rút gọn
    socket.data.userId = userId;
    socket.data.roomId = null;
    userProfiles.set(userId, { socketId: socket.id, username: `Guest_${userId.substring(0, 4)}`, friends: [] });
    
    socket.emit('my_user_id', userId); // Gửi ID về client
    console.log(`User connected: ${socket.id} (ID: ${userId})`);


    // --- Ghép trận Nhanh ---
    socket.on('join_queue', (gameType) => {
        if (matchQueues[gameType]) {
            Object.values(matchQueues).forEach(queue => {
                const index = queue.indexOf(socket.id);
                if (index > -1) queue.splice(index, 1);
            });
            
            matchQueues[gameType].push(socket.id);
            socket.emit('queue_update', `Đã vào hàng đợi ${gameType}. Đang chờ...`);
            
            checkAndStartMatch(gameType);
        } else {
            socket.emit('error', 'Loại game không hợp lệ.');
        }
    });

    // --- Ghép trận Solo/Private ---
    socket.on('create_private_room', (gameType) => {
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const roomId = `R_${nextRoomId++}`;
        privateRoomCodes.set(roomCode, roomId);
        
        const newGame = createNewGame(gameType, [socket.data.userId], true);
        activeRooms.set(roomId, newGame);
        
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.emit('private_room_created', { roomId, roomCode, gameType });
    });

    socket.on('join_private_room', (roomCode) => {
        const roomId = privateRoomCodes.get(roomCode);
        if (!roomId || !activeRooms.get(roomId)) {
            return socket.emit('error', 'Mã phòng không hợp lệ hoặc phòng đã đầy.');
        }
        
        const gameState = activeRooms.get(roomId);
        if (gameState.players.length >= 4) {
             return socket.emit('error', 'Phòng đã đầy.');
        }
        
        // Thêm người chơi vào phòng
        gameState.players.push(socket.data.userId);
        
        socket.join(roomId);
        socket.data.roomId = roomId;
        io.to(roomId).emit('player_joined', socket.data.userId);

        // BẮT ĐẦU GAME nếu đủ người
        if (gameState.players.length === 4) {
            const finalGame = createNewGame(gameState.type, gameState.players, true);
            redis.set(`room:${roomId}`, JSON.stringify(finalGame));
            io.to(roomId).emit('game_state_update', finalGame);
        } else {
             io.to(roomId).emit('game_state_update', gameState);
        }
    });
    
    // --- Hành động Báo Sâm ---
    socket.on('bao_sam', async (data) => {
        const { roomId } = data;
        const roomStateStr = await redis.get(`room:${roomId}`);
        if (!roomStateStr) return;
        let roomState = JSON.parse(roomStateStr);

        if (roomState.status !== 'waiting_action' || roomState.samCalled) {
            return socket.emit('error', 'Không thể Báo Sâm lúc này.');
        }

        roomState.samCalled = socket.data.userId;
        roomState.status = 'playing';
        roomState.currentPlayer = socket.data.userId; 
        
        await redis.set(`room:${roomId}`, JSON.stringify(roomState));
        io.to(roomId).emit('game_state_update', roomState);
        io.to(roomId).emit('chat_message', `Người chơi ${socket.data.userId} ĐÃ BÁO SÂM!`);
    });


    // --- Hành động Đánh bài ---
    socket.on('play_cards', async (data) => {
        const { roomId, cards } = data;
        const roomStateStr = await redis.get(`room:${roomId}`);
        if (!roomStateStr) return;
        let roomState = JSON.parse(roomStateStr);

        if (roomState.currentPlayer !== socket.data.userId) return socket.emit('error', 'Không phải lượt của bạn.');
        
        // 1. Kiểm tra tính hợp lệ và luật ăn đè
        if (!isValidSet(cards, roomState.type) || !canBeat(cards, roomState.lastPlayed, roomState.type)) {
            return socket.emit('error', 'Bộ bài không hợp lệ hoặc không thể ăn được.');
        }

        // 2. Xóa bài khỏi tay người chơi (Logic cần được viết)
        
        // 3. Cập nhật trạng thái
        roomState.lastPlayed = cards;
        roomState.passCount = 0; 
        roomState.mustPlay = false; 
        
        // 4. Cập nhật lượt chơi (Logic tìm người chơi tiếp theo cần được viết)

        await redis.set(`room:${roomId}`, JSON.stringify(roomState));
        io.to(roomId).emit('game_state_update', roomState);
    });
    
    // --- Hành động Bỏ lượt ---
    socket.on('pass', async (data) => {
        const { roomId } = data;
        const roomStateStr = await redis.get(`room:${roomId}`);
        if (!roomStateStr) return;
        let roomState = JSON.parse(roomStateStr);

        if (roomState.currentPlayer !== socket.data.userId) return;
        if (roomState.mustPlay) return socket.emit('error', 'Bạn không thể bỏ lượt lúc này!');

        roomState.passCount++;
        
        // Xử lý Quy tắc 3/3 Bỏ lượt
        if (roomState.passCount === roomState.players.length - 1) { 
            roomState.passCount = 0; 
            roomState.lastPlayed = null; // Bàn chơi mới, người bỏ lượt cuối được đi
            // (Cần logic xác định người đi tiếp)
        }
        
        // Cập nhật lượt chơi tiếp theo
        await redis.set(`room:${roomId}`, JSON.stringify(roomState));
        io.to(roomId).emit('game_state_update', roomState);
    });


    // --- Xử lý ngắt kết nối ---
    socket.on('disconnect', () => {
        userProfiles.delete(socket.data.userId);
        // ... (Logic xóa người chơi khỏi Queue và Phòng) ...
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
