/** Starter sketches. They use #ifdef so the same text runs on all three supported boards. */

export interface SketchTemplate {
  id: string;
  name: string;
  description: string;
  code: string;
}

const PINS = `#if defined(ESP32)
  #define LED_PIN 2
  #define BTN_PIN 4
  #define POT_PIN 34
  #define PWM_PIN 16
  #define SERVO_PIN 18
  #define TRIG_PIN 5
  #define ECHO_PIN 17
#elif defined(__AVR_ATtiny85__)
  #define LED_PIN 1
  #define BTN_PIN 2
  #define POT_PIN A2
  #define PWM_PIN 0
  #define SERVO_PIN 0
  #define TRIG_PIN 3
  #define ECHO_PIN 4
#else
  #define LED_PIN 13
  #define BTN_PIN 2
  #define POT_PIN A0
  #define PWM_PIN 9
  #define SERVO_PIN 9
  #define TRIG_PIN 7
  #define ECHO_PIN 8
#endif
`;

export const TEMPLATES: SketchTemplate[] = [
  {
    id: "blink",
    name: "Blink",
    description: "Toggle an LED once per second.",
    code: `${PINS}
void setup() {
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  delay(500);
  digitalWrite(LED_PIN, LOW);
  delay(500);
}
`,
  },
  {
    id: "button",
    name: "Button → LED",
    description: "LED follows a push button wired to ground (internal pull-up).",
    code: `${PINS}
void setup() {
  pinMode(LED_PIN, OUTPUT);
  pinMode(BTN_PIN, INPUT_PULLUP);
}

void loop() {
  // the button pulls the pin LOW when pressed
  digitalWrite(LED_PIN, digitalRead(BTN_PIN) == LOW);
}
`,
  },
  {
    id: "fade",
    name: "PWM fade",
    description: "Smoothly fade an LED with analogWrite.",
    code: `${PINS}
int brightness = 0;
int step = 5;

void setup() {
  pinMode(PWM_PIN, OUTPUT);
}

void loop() {
  analogWrite(PWM_PIN, brightness);
  brightness += step;
  if (brightness <= 0 || brightness >= 255) step = -step;
  delay(20);
}
`,
  },
  {
    id: "pot",
    name: "Pot → Serial + LED",
    description: "Read a potentiometer, print it and dim an LED.",
    code: `${PINS}
void setup() {
  Serial.begin(9600);
  pinMode(PWM_PIN, OUTPUT);
}

void loop() {
  int raw = analogRead(POT_PIN);
  #if defined(ESP32)
    int duty = map(raw, 0, 4095, 0, 255);
  #else
    int duty = map(raw, 0, 1023, 0, 255);
  #endif
  analogWrite(PWM_PIN, duty);
  Serial.print("raw=");
  Serial.print(raw);
  Serial.print("  duty=");
  Serial.println(duty);
  delay(250);
}
`,
  },
  {
    id: "serial",
    name: "Serial echo",
    description: "Type in the serial monitor; the board answers and toggles the LED on '1'/'0'.",
    code: `${PINS}
void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("Type 1 to turn the LED on, 0 to turn it off.");
}

void loop() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '1') { digitalWrite(LED_PIN, HIGH); Serial.println("LED on"); }
    else if (c == '0') { digitalWrite(LED_PIN, LOW); Serial.println("LED off"); }
  }
}
`,
  },
  {
    id: "servo",
    name: "Servo sweep",
    description: "Sweep a hobby servo from 0° to 180° and back.",
    code: `#include <Servo.h>
${PINS}
Servo myServo;

void setup() {
  myServo.attach(SERVO_PIN);
}

void loop() {
  for (int pos = 0; pos <= 180; pos += 3) {
    myServo.write(pos);
    delay(30);
  }
  for (int pos = 180; pos >= 0; pos -= 3) {
    myServo.write(pos);
    delay(30);
  }
}
`,
  },
  {
    id: "sonar",
    name: "HC-SR04 distance",
    description: "Measure distance with an ultrasonic sensor and print it.",
    code: `${PINS}
void setup() {
  Serial.begin(9600);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
}

void loop() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long us = pulseIn(ECHO_PIN, HIGH, 30000);
  float cm = us / 58.0;
  Serial.print("distance: ");
  Serial.print(cm, 1);
  Serial.println(" cm");
  delay(300);
}
`,
  },
  {
    id: "lcd",
    name: "LCD 16×2 hello",
    description: "Write text on an HD44780 display wired in 4-bit mode (RS, E, D4–D7).",
    code: `#include <LiquidCrystal.h>

// rs, enable, d4, d5, d6, d7
#if defined(ESP32)
  LiquidCrystal lcd(23, 22, 21, 19, 18, 5);
#else
  LiquidCrystal lcd(12, 11, 5, 4, 3, 2);
#endif

void setup() {
  lcd.begin(16, 2);
  lcd.print("Hello, CircuitLab");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print("t = ");
  lcd.print(millis() / 1000);
  lcd.print(" s   ");
  delay(200);
}
`,
  },
  {
    id: "interrupt",
    name: "Interrupt counter",
    description: "Count button presses with an external interrupt and print them.",
    code: `${PINS}
volatile int presses = 0;

void onPress() {
  presses++;
}

void setup() {
  Serial.begin(9600);
  pinMode(BTN_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BTN_PIN), onPress, FALLING);
}

void loop() {
  Serial.print("presses: ");
  Serial.println(presses);
  delay(500);
}
`,
  },
];

export const DEFAULT_SKETCH = TEMPLATES[0]!.code;

export function templateById(id: string): SketchTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
