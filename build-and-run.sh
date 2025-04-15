#!/bin/bash

# 스크립트 실행 중 오류 발생 시 종료
set -e

# 색상 설정
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 로그 함수
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 이미지 이름 및 태그 설정
IMAGE_NAME="lightweight"
IMAGE_TAG="latest"
FULL_IMAGE_NAME="${IMAGE_NAME}:${IMAGE_TAG}"

# 컨테이너 이름
CONTAINER_NAME="lightweight-metrics"

# 포트 설정 (3002로 변경됨)
HOST_PORT=3002
CONTAINER_PORT=3002

# Step 1: Docker 이미지 빌드
log_info "Docker 이미지 빌드 시작..."
if ! docker build -t ${FULL_IMAGE_NAME} .; then
    log_error "Docker 이미지 빌드 실패"
    exit 1
fi
log_info "Docker 이미지 빌드 완료: ${FULL_IMAGE_NAME}"

# Step 2: 이전에 실행 중인 동일한 이름의 컨테이너가 있다면 중지 및 제거
if docker ps -a | grep -q ${CONTAINER_NAME}; then
    log_warn "이전에 실행 중인 ${CONTAINER_NAME} 컨테이너 발견, 중지 및 제거 중..."
    docker stop ${CONTAINER_NAME} 2>/dev/null || true
    docker rm ${CONTAINER_NAME} 2>/dev/null || true
fi

# Step 3: Docker 컨테이너 실행
log_info "Docker 컨테이너 실행 중..."
docker run -d \
  --name ${CONTAINER_NAME} \
  -p ${HOST_PORT}:${CONTAINER_PORT} \
  -e METRICS_TARGET=host \
  -e PORT=${CONTAINER_PORT} \
  --cap-add SYS_PTRACE \
  -v /proc:/host/proc:ro \
  -v /sys:/host/sys:ro \
  ${FULL_IMAGE_NAME}

# 실행 확인
if [ $? -eq 0 ]; then
    CONTAINER_ID=$(docker ps -q -f name=${CONTAINER_NAME})
    log_info "컨테이너가 성공적으로 시작되었습니다."
    log_info "컨테이너 ID: ${CONTAINER_ID}"
    log_info "웹 인터페이스 접속: http://localhost:${HOST_PORT}"
    log_info "컨테이너 로그 확인: docker logs ${CONTAINER_NAME}"
    log_info "컨테이너 중지: docker stop ${CONTAINER_NAME}"
else
    log_error "컨테이너 시작 실패"
    exit 1
fi

# 로그 표시 (선택적)
log_info "컨테이너 로그 출력 중... (Ctrl+C로 종료)"
docker logs -f ${CONTAINER_NAME} 