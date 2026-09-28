# Отчёт о тестировании — 28.09.2026, завершение HTTPS

## Контекст

- Запрос: завершить оставшуюся работу по совместимости с HTTPS-сертификатами Минцифры. Объём — текущие автоматические варианты BE-21 и BE-22, без публикации.
- Начало: 28.09.2026 20:15; окончание проверки: 28.09.2026 20:17, Asia/Jerusalem (UTC+03:00).
- Версия: рабочее дерево без первого Git-коммита; исходники untracked. [SHA-256 проверенных файлов](2026-09-28-2015-tls-source-hashes.json).
- Среда: Windows, Node.js 24.19.0, pnpm 11.25.0. HTTPS-сервер теста на случайном локальном порту 127.0.0.1.
- БД: изолированный PGlite memory, рабочие data/postgres и data/demo/postgres не использовались.
- Браузер: NOT RUN; выполнены настоящие TLS-запросы через Node HTTPS-клиент с проверкой сертификата.
- Подготовка: временный тестовый CA, сертификат localhost и случайные тестовые ключи/пароль; секреты не включены в отчёт.
- Интеграции: Telegram не подключён; туннель не публиковался. Системное хранилище доверия не менялось.

## Результаты

| ID и вариант | Статус | Ожидание / факт | Доказательство |
|---|---|---|---|
| BE-21, TLS handshake | PASS | Соединение с явным доверием к тестовому CA успешно; без доверия и с неверным hostname отклонено; TLS 1.2 и 1.3 работают | tls.test.ts: TLS handshake requires a trusted CA and correct hostname |
| BE-21, загрузчик сертификатов | PASS | Неверные SAN/ключ/срок/цепочка отклоняются до старта; корректный PEM-bundle загружается | tls.test.ts: TLS loader rejects key mismatch, wrong SAN and expired certificate before startup |
| BE-21, сессия сотрудника по HTTPS | PASS | Создание тестовой сессии и чтение сессии успешны; cookie Secure/HttpOnly; чужой Origin отклонён | tls.test.ts: staff session works over HTTPS with Secure cookie and strict Origin checks |
| BE-22, конфигурация транспорта | PASS | Локальный HTTP допустим; некорректная TLS/proxy-конфигурация отклонена; production требует TLS или явный loopback proxy | tls.test.ts: transport config fails closed; local HTTP stays available; proxy binding is restricted |
| BE-22, доверенный proxy | PASS | Forwarded IP/protocol принимаются только от явно доверенного loopback | tls.test.ts: forwarded client address is accepted only from explicitly trusted loopback proxy |
| BE-22, заголовки demo-proxy | PASS | Поддельные forwarding-заголовки заменяются; чужой host, HTTP и отсутствие идентичности клиента отклоняются | demo.test.ts: tunnel replaces forged forwarding headers and rejects wrong host, HTTP and missing client identity |
| BE-22, публичный bootstrap | PASS | Публичное создание владельца запрещено, обязательны авторизация и корректный Origin | demo.test.ts: HTTPS preview disables public owner creation and enforces admin origin and authorization |
| Реальный домен и выданный сертификат Минцифры | BLOCKED | Домен, выданная цепочка и сервер размещения для этой задачи не предоставлены | Нельзя считать тестовый CA проверкой конкретного УЦ |
| Nginx nginx -t и deployment | NOT RUN | Проверен текст шаблона; Nginx и сертификат на целевом сервере не запускались | deploy/nginx/angasolka.conf.example |
| Браузеры посетителей | NOT RUN | Матрица доверия Яндекс/Chrome/Safari/Firefox на реальном домене не проверялась | Отдельный этап ввода в эксплуатацию |

## Команды

| Команда без секретов | Код завершения | Результат и среда |
|---|---|---|
| pnpm check | 0 | TypeScript без ошибок |
| pnpm exec tsx --test tests/tls.test.ts tests/demo.test.ts | 1 | В текущей среде pnpm exec не нашёл исполняемый tsx; тесты не начались |
| pnpm test | 1 | Песочница Windows запретила дочерние процессы: spawn EPERM; не является выполненным регрессом |
| node --import tsx --test --test-concurrency=1 tests/tls.test.ts tests/demo.test.ts | 1 | Та же блокировка дочерних процессов в песочнице |
| Та же команда после разрешённой эскалации | 0 | 7 PASS, 0 FAIL; 8,43 с, изоляция тестовых файлов сохранена |

## Дефекты

В выполненных TLS-проверках дефектов приложения не обнаружено. Ошибка прежнего прогона `PEM routines::bad end line` уже исправлена в актуальном tests/tls.test.ts: при объединении PEM-сертификатов вставляется перевод строки. Повторная проверка корректной и некорректной цепочки прошла. В этой задаче дополнительная правка приложения не потребовалась; изменены только отчёт и документация.

## Итог

- Единица подсчёта — строка таблицы: 7 PASS / 0 FAIL / 1 BLOCKED / 2 NOT RUN / 0 N/A. Автотесты: 7 из 7 PASS.
- Проверена программная поддержка HTTPS, PEM-цепочки, защищённой сессии и loopback proxy. Поддержка подключения стандартного сертификата реализована.
- Не проверены: настоящий сертификат Минцифры, отзыв/полнота цепочки до реального доверенного корня, браузеры посетителей и Nginx deployment. Серверный PostgreSQL к этому прогону не подключался.
- Полный регресс приложения не заявляется успешным по этому прогону; после успешной целевой проверки тестирование не расширялось.
- Следующее действие: получить сертификат для выбранного домена и установить на целевой сервер по docs/tls-russia.md. Закрытый ключ хранить на сервере, не отправлять в чат.
- Очистка: тестовые HTTPS-серверы закрыты hooks after/finally, БД в памяти закрыты, временная папка сертификатов удалена. Рабочие процессы, данные и системные доверенные корни не менялись.
