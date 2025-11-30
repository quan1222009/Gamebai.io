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

// Kết nối Redis (Quan trọng cho Render.com)
const redis = new Redis(REDIS_URL);


// #######################################################
// --- 2. LOGIC BÀI TÂY CƠ BẢN (CARD DECK LOGIC) ---
// #######################################################

// Định nghĩa thứ tự chất: Cơ (4) > Rô (3) > Tép (2) > Bích (1)
const SUIT_ORDER = {
    'C': 4, // Cơ (Hearts)
    'R': 3, // Rô (Diamonds)
    'T': 2, // Tép (Clubs)
    'B': 1  // Bích (Spades)
};

// Định nghĩa các loại lá bài và giá trị Rank
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
            deck.push({
                rank: rank,
                suit: suit,
                value: RANK_VALUES[rank],
                suit_value: SUIT_ORDER[suit]
            });
        }
    }
    
    // Thuật toán Fisher-Yates Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]]; // Swap
    }
    
    return deck;
}

// #######################################################
// --- 3. LOGIC QUẢN LÝ GAME TỔNG QUAN ---
// #######################################################

// Hàng đợi ghép trận (Queue)
const matchQueues = {
    'sam': [],
    'tienlen': [],
    'lieng': [],
    'bacay': []
};

// Cấu trúc để lưu trữ thông tin game đang diễn ra
const activeRooms = new Map();
let nextRoomId = 1;

/**
 * Tạo và khởi tạo trạng thái game mới, chia bài và chọn người đi trước.
 */
function createNewGame(gameType, players) {
    // Sâm/Tiến Lên: 13 lá, Liêng/3 Cây: 3 lá
    const cardsToDeal = (gameType === 'sam' || gameType === 'tienlen') ? 13 : 3;

    const deck = createAndShuffleDeck(); 
    const playerCards = {};
    
    let k = 0;
    for (const player of players) {
        // Chia bài
        playerCards[player] = deck.slice(k, k + cardsToDeal);
        k += cardsToDeal;
        
        // Sắp xếp bài (giá trị rank tăng dần, sau đó chất tăng dần)
        playerCards[player].sort((a, b) => {
            if (a.value !== b.value) return a.value - b.value;
            return a.suit_value - b.suit_value;
        });
    }

    // Chọn ngẫu nhiên 1 người đi trước
    const starterId = players[Math.floor(Math.random() * players.length)];
    
    const gameState = {
        id: `R_${nextRoomId++}`,
        type: gameType,
        players: players,
        status: 'playing',
        cards: playerCards, // Bài đã chia và sắp xếp
        currentPlayer: starterId, 
        lastPlayed: null, 
        passCount: 0 
    };

    // LƯU TRẠNG THÁI GAME VÀO REDIS
    redis.set(`room:${gameState.id}`, JSON.stringify(gameState));
    
    return gameState;
}


// --- 4. LOGIC GHÉP TRẬN (MATCHMAKING) ---

/**
 * Kiểm tra và bắt đầu trận đấu nếu đủ người.
 * @param {string} gameType
 */
function checkAndStartMatch(gameType) {
    const queue = matchQueues[gameType];
    
    // Yêu cầu tối thiểu: 4 người cho Sâm/Tiến Lên, 2 người cho Liêng/3 Cây (có thể là 4 người cho tiêu chuẩn)
    const MIN_PLAYERS = (gameType === 'sam' || gameType === 'tienlen') ? 4 : 4; 

    if (queue.length >= MIN_PLAYERS) {
        const players = queue.splice(0, MIN_PLAYERS);
        
        const newGame = createNewGame(gameType, players);
        activeRooms.set(newGame.id, newGame);

        // Gửi thông báo đến tất cả người chơi trong phòng mới
        players.forEach(socketId => {
            const playerSocket = io.sockets.sockets.get(socketId);
            if (playerSocket) {
                playerSocket.join(newGame.id); 
                playerSocket.emit('match_found', {
                    roomId: newGame.id,
                    gameType: gameType,
                    players: players
                });
                playerSocket.emit('game_state_update', newGame); 
            }
        });

        console.log(`[MATCH] Game ${newGame.id} started for ${gameType} with ${players.length} players.`);
    }
}


// --- 5. SOCKET.IO: XỬ LÝ KẾT NỐI VÀ HÀNH ĐỘNG GAME ---

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    
    // --- Ghép trận Nhanh ---
    socket.on('join_queue', (gameType) => {
        if (matchQueues[gameType]) {
            // Loại bỏ người chơi khỏi queue khác nếu họ đã ở đó
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
    
    // --- Hành động trong Game: Đánh bài ---
    socket.on('play_cards', async (data) => {
        const { roomId, cards } = data;
        const roomStateStr = await redis.get(`room:${roomId}`);

        if (!roomStateStr) return socket.emit('error', 'Phòng không tồn tại.');
        let roomState = JSON.parse(roomStateStr);

        // 1. Kiểm tra lượt
        if (roomState.currentPlayer !== socket.id) {
            return socket.emit('error', 'Không phải lượt của bạn.');
        }

        // 2. LOGIC KIỂM TRA LUẬT ĐÁNH BÀI CẦN ĐƯỢC THÊM VÀO ĐÂY!
        // (Đây là nơi xử lý quy tắc Sâm/Tiến Lên/Liêng, ĂN ĐÈ, v.v.)
        
        // 3. Cập nhật trạng thái game (Tạm thời)
        // roomState.lastPlayed = cards;
        // roomState.cards[socket.id] = roomState.cards[socket.id].filter(...) // Xóa bài đã đánh
        // roomState.currentPlayer = nextPlayerId;
        
        // LƯU TRẠNG THÁI MỚI VÀO REDIS
        await redis.set(`room:${roomId}`, JSON.stringify(roomState));

        // Gửi trạng thái game MỚI đến TẤT CẢ mọi người trong phòng
        io.to(roomId).emit('game_state_update', roomState);
    });

    // --- Hành động Báo Sâm ---
    socket.on('bao_sam', async (data) => {
        const { roomId } = data;
        // LOGIC BÁO SÂM CẦN ĐƯỢC THÊM VÀO ĐÂY!
        // ...
    });

    // --- Xử lý ngắt kết nối ---
    socket.on('disconnect', () => {
        // ... (Logic xóa người chơi khỏi queue và phòng đang chơi)
    });
});


// --- 6. EXPRESS ROUTING: PHỤC VỤ TRANG TĨNH ---
// Cần tạo thư mục 'public' chứa index.html
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});


// --- 7. KHỞI ĐỘNG SERVER ---
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Redis connected: ${REDIS_URL}`);
});
