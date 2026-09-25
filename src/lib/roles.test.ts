/**
 * Unit tests for the admin / superadmin role helpers.
 */
import { describe, expect, it } from 'vitest'
import { isAdminRole, isSuperAdminRole, ROLE_LABEL } from './roles'

describe('isAdminRole', () => {
  it('admits admin and superadmin', () => {
    expect(isAdminRole('admin')).toBe(true)
    expect(isAdminRole('superadmin')).toBe(true)
  })

  it('excludes users and nullish values', () => {
    expect(isAdminRole('user')).toBe(false)
    expect(isAdminRole(null)).toBe(false)
    expect(isAdminRole(undefined)).toBe(false)
  })
})

describe('isSuperAdminRole', () => {
  it('admits only superadmin', () => {
    expect(isSuperAdminRole('superadmin')).toBe(true)
    expect(isSuperAdminRole('admin')).toBe(false)
    expect(isSuperAdminRole('user')).toBe(false)
    expect(isSuperAdminRole(null)).toBe(false)
  })
})

describe('ROLE_LABEL', () => {
  it('labels every valid role', () => {
    expect(ROLE_LABEL.user).toBe('User')
    expect(ROLE_LABEL.admin).toBe('Admin')
    expect(ROLE_LABEL.superadmin).toBe('Superadmin')
  })
})
