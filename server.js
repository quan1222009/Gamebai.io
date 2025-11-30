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
// Sử dụng biến môi trường cho Render.com

// Kết nối Redis
const redis = new Redis(REDIS_URL);

// --- 2. LOGIC QUẢN LÝ GAME TỔNG QUAN ---
// Hàng đợi ghép trận (Queue)
const matchQueues = {
    'sam': [],
    'tienlen': [],
    'lieng': [],
    'bacay': []
};

// Cấu trúc để lưu trữ thông tin game đang diễn ra (roomId -> game state)
// Sẽ lưu trữ chi tiết state game trên Redis, còn đây là Map tạm thời
const activeRooms = new Map();
let nextRoomId = 1;

/**
 * Hàm đại diện cho logic chia bài, kiểm tra luật, v.v.
 * Đây là nơi cần code logic chi tiết cho 4 loại game.
 * @param {string} gameType - Loại game ('sam', 'tienlen', v.v.)
 * @param {string[]} players - Mảng ID người chơi
 * @returns {object} Trạng thái game khởi tạo
 */
function createNewGame(gameType, players) {
    // Logic: Khởi tạo bộ bài 52 lá, xáo bài, chia bài.
    // Logic: Chọn ngẫu nhiên 1 người đi trước.
    
    // Ví dụ về cấu trúc trạng thái game (Game State)
    const gameState = {
        id: `R_${nextRoomId++}`,
        type: gameType,
        players: players,
        status: 'playing',
        cards: { /* Bài của từng người chơi */ },
        currentPlayer: players[Math.floor(Math.random() * players.length)], // Chọn ngẫu nhiên
        lastPlayed: null, // Lá bài/bộ bài cuối cùng được đánh
        passCount: 0 // Đếm lượt bỏ
    };

    // LƯU TRẠNG THÁI GAME VÀO REDIS
    redis.set(`room:${gameState.id}`, JSON.stringify(gameState));
    
    return gameState;
}


// --- 3. LOGIC GHÉP TRẬN (MATCHMAKING) ---

/**
 * Kiểm tra và bắt đầu trận đấu nếu đủ người.
 * @param {string} gameType
 */
function checkAndStartMatch(gameType) {
    const queue = matchQueues[gameType];
    const MIN_PLAYERS = 4; // Ví dụ: Cần 4 người cho Tiến Lên/Sâm

    if (queue.length >= MIN_PLAYERS) {
        // Lấy 4 người chơi đầu tiên
        const players = queue.splice(0, MIN_PLAYERS);
        
        // **Thêm logic BOT nếu cần**
        
        // Tạo game mới
        const newGame = createNewGame(gameType, players);
        activeRooms.set(newGame.id, newGame);

        // Gửi thông báo đến tất cả người chơi trong phòng mới
        players.forEach(socketId => {
            const playerSocket = io.sockets.sockets.get(socketId);
            if (playerSocket) {
                playerSocket.join(newGame.id); // Cho người chơi vào phòng Socket.IO
                playerSocket.emit('match_found', {
                    roomId: newGame.id,
                    gameType: gameType,
                    players: players
                });
                playerSocket.emit('game_state_update', newGame); // Gửi trạng thái game
            }
        });

        console.log(`[MATCH] Game ${newGame.id} started for ${gameType} with ${players.length} players.`);
    }
}


// --- 4. SOCKET.IO: XỬ LÝ KẾT NỐI VÀ HÀNH ĐỘNG GAME ---

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    
    // --- Ghép trận Nhanh (Ví dụ) ---
    socket.on('join_queue', (gameType) => {
        if (matchQueues[gameType]) {
            // Đảm bảo người chơi không ở trong queue khác
            Object.values(matchQueues).forEach(queue => {
                const index = queue.indexOf(socket.id);
                if (index > -1) queue.splice(index, 1);
            });
            
            matchQueues[gameType].push(socket.id);
            socket.emit('queue_update', `Đã vào hàng đợi ${gameType}. Đang chờ...`);
            console.log(`[QUEUE] ${socket.id} joined ${gameType} queue. Total: ${matchQueues[gameType].length}`);
            
            checkAndStartMatch(gameType);
        } else {
            socket.emit('error', 'Loại game không hợp lệ.');
        }
    });
    
    // --- Hành động trong Game ---
    socket.on('play_cards', async (data) => {
        const { roomId, cards } = data;
        const roomStateStr = await redis.get(`room:${roomId}`);

        if (!roomStateStr) return socket.emit('error', 'Phòng không tồn tại.');
        let roomState = JSON.parse(roomStateStr);

        // 1. Kiểm tra lượt: Phải là lượt của người chơi này (socket.id)
        if (roomState.currentPlayer !== socket.id) {
            return socket.emit('error', 'Không phải lượt của bạn.');
        }

        // 2. Logic Kiểm tra Luật Đánh Bài (Đây là phần phức tạp nhất)
        // Ví dụ: Kiểm tra xem 'cards' có hợp lệ không (ví dụ: đôi, sảnh, v.v.)
        // Ví dụ: Kiểm tra xem 'cards' có lớn hơn 'roomState.lastPlayed' không (dựa trên rank và suit_value)
        
        // Sau khi kiểm tra HỢP LỆ:
        // Cập nhật roomState: Xóa bài khỏi tay người chơi, cập nhật lastPlayed.
        
        // Cập nhật người chơi tiếp theo (Next Player)
        // Nếu người chơi hết bài, xử lý thắng/thua.
        
        // LƯU TRẠẠNG THÁI MỚI VÀO REDIS
        await redis.set(`room:${roomId}`, JSON.stringify(roomState));

        // Gửi trạng thái game MỚI đến TẤT CẢ mọi người trong phòng
        io.to(roomId).emit('game_state_update', roomState);
    });

    // --- Hành động Báo Sâm ---
    socket.on('bao_sam', async (data) => {
        const { roomId } = data;
        // Logic kiểm tra Báo Sâm (chỉ được báo trong 1 lượt đầu, kiểm tra bài có khả năng thắng 100% không)
        // Nếu hợp lệ: Cập nhật roomState, thông báo tới phòng.
    });

    // --- Xử lý ngắt kết nối ---
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // Xóa người chơi khỏi tất cả Queue (nếu có)
        Object.values(matchQueues).forEach(queue => {
            const index = queue.indexOf(socket.id);
            if (index > -1) queue.splice(index, 1);
        });
        
        // Xử lý game đang diễn ra (ví dụ: đánh dấu người chơi này là 'disconnected')
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
