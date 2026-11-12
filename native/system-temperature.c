/*
 * Temperature read flows are adapted from btop's macOS collectors.
 * Copyright 2021 Aristocratos (jakob@qvantnet.com)
 * Licensed under the Apache License, Version 2.0.
 * https://www.apache.org/licenses/LICENSE-2.0
 */
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/hidsystem/IOHIDEventSystemClient.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define KERNEL_INDEX_SMC 2
#define SMC_CMD_READ_BYTES 5
#define SMC_CMD_READ_KEYINFO 9
#define IOHID_EVENT_FIELD_BASE(type) ((type) << 16)
#define IOHID_EVENT_TYPE_TEMPERATURE 15

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDServiceClient *IOHIDServiceClientRef;
typedef double IOHIDFloat;

IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
int IOHIDEventSystemClientSetMatching(IOHIDEventSystemClientRef client, CFDictionaryRef match);
IOHIDEventRef IOHIDServiceClientCopyEvent(IOHIDServiceClientRef service, int64_t type, int32_t options, int64_t timestamp);
CFStringRef IOHIDServiceClientCopyProperty(IOHIDServiceClientRef service, CFStringRef property);
IOHIDFloat IOHIDEventGetFloatValue(IOHIDEventRef event, int32_t field);

typedef struct {
  char major;
  char minor;
  char build;
  char reserved;
  uint16_t release;
} smc_version_t;

typedef struct {
  uint16_t version;
  uint16_t length;
  uint32_t cpu_limit;
  uint32_t gpu_limit;
  uint32_t memory_limit;
} smc_limit_t;

typedef struct {
  uint32_t data_size;
  uint32_t data_type;
  char attributes;
} smc_key_info_t;

typedef struct {
  uint32_t key;
  smc_version_t version;
  smc_limit_t limits;
  smc_key_info_t key_info;
  char result;
  char status;
  char data8;
  uint32_t data32;
  char bytes[32];
} smc_key_data_t;

static uint32_t key_value(const char key[4]) {
  return ((uint32_t)(unsigned char)key[0] << 24)
    | ((uint32_t)(unsigned char)key[1] << 16)
    | ((uint32_t)(unsigned char)key[2] << 8)
    | (uint32_t)(unsigned char)key[3];
}

static kern_return_t smc_call(io_connect_t connection, smc_key_data_t *input, smc_key_data_t *output) {
  size_t input_size = sizeof(*input);
  size_t output_size = sizeof(*output);
  return IOConnectCallStructMethod(connection, KERNEL_INDEX_SMC, input, input_size, output, &output_size);
}

static CFDictionaryRef temperature_matching(void) {
  int page = 0xff00;
  int usage = 5;
  CFStringRef keys[] = { CFSTR("PrimaryUsagePage"), CFSTR("PrimaryUsage") };
  CFNumberRef values[] = {
    CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &page),
    CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &usage)
  };
  CFDictionaryRef dictionary = CFDictionaryCreate(
    kCFAllocatorDefault,
    (const void **)keys,
    (const void **)values,
    2,
    &kCFTypeDictionaryKeyCallBacks,
    &kCFTypeDictionaryValueCallBacks
  );
  CFRelease(values[0]);
  CFRelease(values[1]);
  return dictionary;
}

static double apple_silicon_temperature(void) {
  CFDictionaryRef matching = temperature_matching();
  IOHIDEventSystemClientRef system = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
  if (system == NULL) {
    CFRelease(matching);
    return -1.0;
  }
  IOHIDEventSystemClientSetMatching(system, matching);
  CFArrayRef services = IOHIDEventSystemClientCopyServices(system);
  double sum = 0.0;
  long sensor_count = 0;
  if (services != NULL) {
    CFIndex count = CFArrayGetCount(services);
    for (CFIndex index = 0; index < count; index += 1) {
      IOHIDServiceClientRef service = (IOHIDServiceClientRef)CFArrayGetValueAtIndex(services, index);
      if (service == NULL) continue;
      CFStringRef product = IOHIDServiceClientCopyProperty(service, CFSTR("Product"));
      if (product == NULL) continue;
      Boolean is_cpu_sensor = CFStringHasPrefix(product, CFSTR("eACC")) || CFStringHasPrefix(product, CFSTR("pACC"));
      CFRelease(product);
      if (!is_cpu_sensor) continue;
      IOHIDEventRef event = IOHIDServiceClientCopyEvent(service, IOHID_EVENT_TYPE_TEMPERATURE, 0, 0);
      if (event == NULL) continue;
      double temperature = IOHIDEventGetFloatValue(event, IOHID_EVENT_FIELD_BASE(IOHID_EVENT_TYPE_TEMPERATURE));
      CFRelease(event);
      if (temperature > -20.0 && temperature < 150.0) {
        sum += temperature;
        sensor_count += 1;
      }
    }
    CFRelease(services);
  }
  CFRelease(system);
  CFRelease(matching);
  return sensor_count ? sum / sensor_count : -1.0;
}

int main(void) {
  double apple_silicon = apple_silicon_temperature();
  if (apple_silicon > -20.0 && apple_silicon < 150.0) {
    printf("%.1f\n", apple_silicon);
    return 0;
  }

  CFMutableDictionaryRef matching = IOServiceMatching("AppleSMC");
  io_iterator_t iterator = IO_OBJECT_NULL;
  kern_return_t matched = IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator);
  if (matched != kIOReturnSuccess) return 1;
  io_service_t device = IOIteratorNext(iterator);
  IOObjectRelease(iterator);
  if (device == IO_OBJECT_NULL) return 1;

  io_connect_t connection = IO_OBJECT_NULL;
  kern_return_t opened = IOServiceOpen(device, mach_task_self(), 0, &connection);
  IOObjectRelease(device);
  if (opened != kIOReturnSuccess) return 1;

  smc_key_data_t input = {0};
  smc_key_data_t output = {0};
  input.key = key_value("TC0P");
  input.data8 = SMC_CMD_READ_KEYINFO;
  kern_return_t result = smc_call(connection, &input, &output);
  if (result != kIOReturnSuccess) {
    IOServiceClose(connection);
    return 1;
  }

  uint32_t data_type = output.key_info.data_type;
  input.key_info.data_size = output.key_info.data_size;
  input.data8 = SMC_CMD_READ_BYTES;
  memset(&output, 0, sizeof(output));
  result = smc_call(connection, &input, &output);
  IOServiceClose(connection);
  if (result != kIOReturnSuccess || data_type != key_value("sp78")) return 1;

  int16_t raw = (int16_t)(((uint16_t)(unsigned char)output.bytes[0] << 8) | (unsigned char)output.bytes[1]);
  double temperature = raw / 256.0;
  if (temperature < -20.0 || temperature > 150.0) return 1;
  printf("%.1f\n", temperature);
  return 0;
}
