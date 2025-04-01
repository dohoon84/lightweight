# 빌드 단계
FROM node:20-alpine AS build

WORKDIR /app

# 의존성 설치
COPY package*.json ./
RUN npm ci

# 소스 복사 및 빌드
COPY . .
RUN npm run build
RUN npm run pkg

# 실행 단계
FROM alpine:latest

WORKDIR /app

# pkg로 빌드된 단일 실행 파일 복사
COPY --from=build /app/dist-pkg/nest-metrics-cgroup /app/nest-metrics-cgroup

# 실행 권한 추가
RUN chmod +x /app/nest-metrics-cgroup

# 포트 노출
EXPOSE 3001

# 실행
CMD ["/app/nest-metrics-cgroup"] 