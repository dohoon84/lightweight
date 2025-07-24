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
# FROM node:20-slim
FROM node:lts-alpine


# 필요한 런타임 패키지 설치 및 보안 설정
RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache \
    libgcc \
    libcrypto3 \
    libssl3 \
    libpwquality

# pwquality 설정
RUN echo "# 최소 패스워드 길이" > /etc/security/pwquality.conf && \
    echo "minlen = 8" >> /etc/security/pwquality.conf && \
    echo "# 이전 패스워드와 달라야 하는 최소 문자 수" >> /etc/security/pwquality.conf && \
    echo "difok = 3" >> /etc/security/pwquality.conf && \
    echo "# 최소 대문자 요구 수" >> /etc/security/pwquality.conf && \
    echo "ucredit = -1" >> /etc/security/pwquality.conf && \
    echo "# 최소 소문자 요구 수" >> /etc/security/pwquality.conf && \
    echo "lcredit = -1" >> /etc/security/pwquality.conf && \
    echo "# 최소 숫자 요구 수" >> /etc/security/pwquality.conf && \
    echo "dcredit = -1" >> /etc/security/pwquality.conf && \
    echo "# 최소 특수문자 요구 수" >> /etc/security/pwquality.conf && \
    echo "ocredit = -1" >> /etc/security/pwquality.conf && \
    echo "# 패스워드 입력 재시도 횟수" >> /etc/security/pwquality.conf && \
    echo "retry = 3" >> /etc/security/pwquality.conf && \
    echo "# root 사용자에게도 정책 적용" >> /etc/security/pwquality.conf && \
    echo "enforce_for_root = 1" >> /etc/security/pwquality.conf

# shadow 파일 권한 설정
RUN chmod 600 /etc/shadow && \
    chown root:root /etc/shadow


WORKDIR /app

# pkg로 빌드된 단일 실행 파일 복사
COPY --from=build /app/dist-pkg/lightweight /app/lightweight

# public 디렉토리 복사 (정적 파일 제공용)
COPY --from=build /app/public /app/public

# 빌드 시점에 템플릿 파일을 기본 설정 파일로 복사
COPY templates/lightweight-metrics.config.template /app/lightweight-metrics.config

# 실행 권한 추가
RUN chmod +x /app/lightweight

# 포트 노출 (3002로 변경)
EXPOSE 3002

# 실행
CMD ["/app/lightweight"] 
