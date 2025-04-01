# Nest Metrics CGroup

도커 컨테이너 내부 메트릭 정보를 수집하는 NestJS 애플리케이션입니다.

## 주요 기능

- 도커 컨테이너 내부의 메트릭 정보 수집 (CPU, 메모리, 디스크 I/O, 네트워크)
- WebSocket을 통한 실시간 메트릭 데이터 전송
- pkg를 사용한 단일 실행 파일 빌드

## 설치 및 실행

### 로컬 개발 환경

```bash
# 의존성 설치
npm install

# 개발 모드로 실행
npm run start:dev
```

### 빌드 및 패키징

```bash
# 빌드
npm run build

# pkg를 사용한 단일 실행 파일 생성
npm run pkg
```

### 도커 컨테이너에서 실행

```bash
# 도커 이미지 빌드
docker build -t nest-metrics-cgroup .

# 도커 컨테이너 실행
docker run -p 3000:3000 nest-metrics-cgroup
```

## 사용 방법

WebSocket 클라이언트를 사용하여 `ws://localhost:3000` 엔드포인트에 연결하면 실시간으로 메트릭 데이터를 수신할 수 있습니다.

```javascript
// 클라이언트 예제 코드
const socket = io('http://localhost:3000');

socket.on('metrics', (data) => {
  console.log('Received metrics:', data);
});
``` 