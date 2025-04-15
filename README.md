# Lightweight Metrics

도커 컨테이너 및 호스트 시스템의 메트릭 정보를 수집하고 실시간으로 시각화하는 NestJS 애플리케이션입니다.

## 주요 기능

- **메트릭 수집**: CPU, 메모리, 디스크 I/O, 네트워크 데이터를 실시간으로 수집
  - 컨테이너 모드: 도커 컨테이너 내부의 메트릭 정보 수집
  - 호스트 모드: 호스트 시스템의 메트릭 정보 수집
- **실시간 시각화**: 수집된 메트릭 데이터를 차트와 게이지로 시각화
- **WebSocket 통신**: Socket.IO를 사용한 실시간 메트릭 데이터 전송
- **경량화**: pkg를 사용한 단일 실행 파일 빌드

## 설치 및 실행

### 로컬 개발 환경

```bash
# 의존성 설치
npm install

# 개발 모드로 실행 (컨테이너 메트릭 수집)
npm run start:dev

# 개발 모드로 실행 (호스트 메트릭 수집)
METRICS_TARGET=host npm run start:dev
```

### 빌드 및 패키징

```bash
# 빌드
npm run build

# pkg를 사용한 단일 실행 파일 생성
npm run pkg
```

### 도커 컨테이너에서 실행

#### 컨테이너 메트릭 수집 모드

```bash
# 도커 이미지 빌드
docker build -t lightweight .

# 도커 컨테이너 실행
docker run -p 3002:3002 lightweight
```

#### 호스트 메트릭 수집 모드

```bash
# 도커 이미지 빌드
docker build -t lightweight .

# 호스트의 /proc을 컨테이너 내부에 마운트하여 실행
docker run -p 3002:3002 -v /proc:/host/proc:ro -e METRICS_TARGET=host lightweight

# 또는 제공된 스크립트 사용
./build-and-run.sh
```

## 메트릭 대시보드 접속

애플리케이션이 실행되면 웹 브라우저에서 다음 URL로 접속하여 메트릭 대시보드를 확인할 수 있습니다:

```
http://localhost:3002
```

대시보드에서는 다음 정보를 시각적으로 확인할 수 있습니다:
- CPU 사용률 (게이지 및 시계열 차트)
- 메모리 사용량 (게이지 및 시계열 차트)
- 디스크 I/O (읽기/쓰기 시계열 차트)
- 네트워크 트래픽 (송신/수신 시계열 차트)

## 외부 애플리케이션에서 WebSocket 연결 방법

다른 애플리케이션에서 Socket.IO 클라이언트를 사용하여 메트릭 데이터를 수신할 수 있습니다.

### 웹 브라우저

```javascript
// Socket.IO 클라이언트 라이브러리 추가
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>

<script>
  // WebSocket 연결 (호스트와 포트를 실제 서버 주소로 변경)
  const socket = io('http://서버주소:3002');

  // 연결 이벤트 처리
  socket.on('connect', () => {
    console.log('서버에 연결되었습니다.');
  });

  // 메트릭 데이터 수신
  socket.on('metrics', (data) => {
    console.log('메트릭 데이터 수신:', data);
    // 여기서 데이터 처리 및 표시 로직 구현
  });

  // 연결 끊김 이벤트 처리
  socket.on('disconnect', (reason) => {
    console.log('서버와의 연결이 끊어졌습니다:', reason);
  });
</script>
```

### Node.js

```javascript
// Socket.IO 클라이언트 설치
// npm install socket.io-client

const { io } = require('socket.io-client');

// WebSocket 연결 (호스트와 포트를 실제 서버 주소로 변경)
const socket = io('http://서버주소:3002');

// 연결 이벤트 처리
socket.on('connect', () => {
  console.log('서버에 연결되었습니다.');
});

// 메트릭 데이터 수신
socket.on('metrics', (data) => {
  console.log('메트릭 데이터 수신:', data);
  // 여기서 데이터 처리 로직 구현
});

// 연결 끊김 이벤트 처리
socket.on('disconnect', (reason) => {
  console.log('서버와의 연결이 끊어졌습니다:', reason);
});
```

## 연결 테스트 방법

### 브라우저 콘솔을 사용한 테스트

1. 브라우저에서 개발자 도구 열기 (F12 또는 Ctrl+Shift+I)
2. 콘솔 탭에서 다음 코드 실행:

```javascript
const socket = io('http://서버주소:3002');
socket.on('connect', () => console.log('연결됨'));
socket.on('metrics', (data) => console.log('메트릭:', data));
```

### 제공된 테스트 클라이언트 사용

프로젝트에 포함된 `test-client.js`를 사용하여 연결을 테스트할 수 있습니다:

```bash
# 서버 주소 수정 (필요한 경우)
# test-client.js 파일 내의 연결 URL 수정

# 테스트 클라이언트 실행
node test-client.js
```

### curl을 사용한 HTTP 상태 확인

WebSocket 연결은 아니지만 서버 상태를 확인할 수 있습니다:

```bash
curl http://서버주소:3002
```

## 추가 정보

- 연결 가능한 WebSocket 엔드포인트: `ws://서버주소:3002/socket.io`
- 기본 HTTP 엔드포인트: `http://서버주소:3002`
- 메트릭 업데이트 주기: 1초 