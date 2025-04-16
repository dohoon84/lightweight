#!/bin/bash
set -e

# 색상 설정
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 로그 함수
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 이미지 및 컨테이너 이름 설정
IMAGE_NAME="lightweight"
IMAGE_TAG="latest"
FULL_IMAGE_NAME="${IMAGE_NAME}:${IMAGE_TAG}"
CONTAINER_NAME="lightweight-metrics"
HOST_PORT=3002
CONTAINER_PORT=3002

# 빌드 디렉토리 설정
BUILD_DIR="./.build-tmp"
log_info "임시 빌드 디렉토리 생성 중: ${BUILD_DIR}"
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

# 복사 제외 대상 정의
EXCLUDE_LIST=(".build-tmp" "influxdb2-data" "influxdb2-config")

log_info "'${EXCLUDE_LIST[*]}' 제외하고 소스 복사 중..."
for file in * .*; do
  # 제외 목록에 있으면 스킵
  for excluded in "${EXCLUDE_LIST[@]}"; do
    if [[ "$file" == "$excluded" ]]; then
      continue 2
    fi
  done

  # 복사 시도 (에러 나면 경고만 출력)
  if ! cp -r "$file" "${BUILD_DIR}/" 2>/dev/null; then
    log_warn "'$file' 복사 실패 (권한 또는 기타 문제로 스킵됨)"
  fi
done

# Docker 이미지 빌드
log_info "Docker 이미지 빌드 시작..."
if ! docker build -t ${FULL_IMAGE_NAME} "${BUILD_DIR}"; then
    log_error "Docker 이미지 빌드 실패"
    rm -rf "${BUILD_DIR}"
    exit 1
fi
log_info "Docker 이미지 빌드 완료: ${FULL_IMAGE_NAME}"

# 기존 컨테이너 정리
if docker ps -a | grep -q ${CONTAINER_NAME}; then
    log_warn "기존 컨테이너 ${CONTAINER_NAME} 발견, 중지 및 제거 중..."
    docker stop ${CONTAINER_NAME} 2>/dev/null || true
    docker rm ${CONTAINER_NAME} 2>/dev/null || true
fi

# Docker 컨테이너 실행
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

# 임시 디렉토리 정리
log_info "임시 빌드 디렉토리 삭제 중..."
rm -rf "${BUILD_DIR}"

# 실행 결과 확인
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
