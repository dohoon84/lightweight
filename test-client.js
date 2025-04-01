const { io } = require('socket.io-client');

// EC2 인스턴스의 퍼블릭 IP 또는 도메인을 사용
const socket = io('http://your-ec2-public-ip:3001', {
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});

// 연결 시도 상태 로깅 추가
socket.on('connect_error', (error) => {
  console.log('Connection error:', error.message);
});

socket.on('connect_timeout', () => {
  console.log('Connection timeout');
});

socket.on('reconnect_attempt', (attemptNumber) => {
  console.log('Trying to reconnect:', attemptNumber);
});

// 연결 성공 시
socket.on('connect', () => {
  console.log('Connected to WebSocket server');
});

// 메트릭 데이터 수신 시
socket.on('metrics', (data) => {
  console.log('Received metrics:', JSON.stringify(data, null, 2));
});

// 에러 발생 시
socket.on('error', (error) => {
  console.error('Socket error:', error);
});

// 연결 해제 시
socket.on('disconnect', () => {
  console.log('Disconnected from WebSocket server');
}); 